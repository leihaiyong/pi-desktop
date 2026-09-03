import { ipcMain, app, dialog, clipboard, shell, nativeTheme, desktopCapturer, screen, BrowserWindow } from "electron";
import { resolveThemeToCssVars } from "../shared/theme.js";
import { t, setLanguage as setUiLanguage, getLanguage as getUiLanguage } from "../shared/i18n.js";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import {
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	getPackageDir,
	resolveModelScopeWithDiagnostics,
	detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import { shellConfigForPlatform } from "./platform.js";
import { groupWorkspaces } from "../shared/workspaces.js";
import { isValidRect, clampCrop } from "../shared/snip.js";
import { parseModelsJson, serializeModelsJson } from "../shared/model-config.js";

// Mirrors the SDK's getDefaultSessionDirPath encoding (the function is not
// exported from the package entry): <agentDir>/sessions/--<cwd, / \ : -> ->--
function sessionDirForCwd(cwd) {
	const resolved = path.resolve(cwd);
	const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getAgentDir(), "sessions", safe);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Cap for base64 file reads over IPC (image attachments only).
const MAX_READ_BASE64_BYTES = 10 * 1024 * 1024;

// IPC allow-list: the renderer talks to main over a single "pi:invoke" channel,
// so gate the channel names explicitly as defense-in-depth.
const IPC_CHANNELS = new Set([
	"host.snapshot",
	"session.prompt",
	"session.steer",
	"session.followUp",
	"session.abort",
	"session.waitForIdle",
	"session.queue.clear",
	"session.compact",
	"session.compact.abort",
	"session.compaction.setAuto",
	"session.retry.setAuto",
	"session.retry.abort",
	"session.steeringMode",
	"session.followUpMode",
	"session.model.set",
	"session.model.cycle",
	"session.thinking.set",
	"session.thinking.cycle",
	"session.scope.set",
	"session.tools.set",
	"session.tools.list",
	"session.bash.run",
	"session.bash.abort",
	"session.bash.record",
	"session.navigateTree",
	"session.forkMessages",
	"session.new",
	"session.resume",
	"session.fork",
	"session.import",
	"session.name.set",
	"session.reload",
	"session.messages",
	"session.stats",
	"session.contextUsage",
	"session.lastAssistantText",
	"session.systemPrompt",
	"session.exportHtml",
	"session.exportJsonl",
	"sessions.list",
	"sessions.delete",
	"sessions.tree",
	"sessions.setLabel",
	"workspaces.list",
	"workspaces.delete",
	"models.list",
	"models.refresh",
	"models.authStatus",
	"models.login",
	"models.logout",
	"models.apiKey.set",
	"models.apiKey.remove",
	"models.config.read",
	"models.config.save",
	"resources.changelog",
	"resources.get",
	"theme.list",
	"theme.css",
	"settings.get",
	"settings.set",
	"trust.get",
	"trust.set",
	"system.platform",
	"system.pickDirectory",
	"system.pickFile",
	"system.readFileBase64",
	"system.fs.list",
	"system.clipboard.write",
	"system.clipboard.readImage",
	"system.displays",
	"system.screenshot",
	"system.screenshot.start",
	"system.openExternal",
	"system.openPath",
	"system.revealPath",
	"system.reconfigure",
	"system.appInfo",
	"i18n.setLanguage",
	"ext.ui.respond",
	"ext.editor.cache",
	"auth.respond",
]);

function gitBranch(cwd) {
	return new Promise((resolve) => {
		execFile(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd, timeout: 3000 },
			(error, stdout) => {
				resolve(error ? undefined : stdout.trim() || undefined);
			},
		);
	});
}

// snapshot() runs on every agent settle; spawning git each time is wasteful
let gitBranchCache = { cwd: "", branch: undefined, at: 0 };
async function gitBranchCached(cwd) {
	if (!cwd) return undefined;
	const now = Date.now();
	if (gitBranchCache.cwd === cwd && now - gitBranchCache.at < 60_000) {
		return gitBranchCache.branch;
	}
	const branch = await gitBranch(cwd);
	gitBranchCache = { cwd, branch, at: now };
	return branch;
}

/**
 * Bridge between the pi SDK (running in the Electron main process) and the
 * renderer UI. Owns the AgentSessionRuntime and all IPC handlers.
 */
export class AgentHost {
	#getWindow;
	#runtime = null;
	#modelRuntime = null;
	#unsubscribeSession = null;
	#uiRequests = new Map();
	#authRequests = new Map();
	#seq = 0;
	#shuttingDown = false;
	#lastEditorText = "";
	#readyPromise = null;
	#readyResolve = null;
	#explicitCwd = false;
	#snipState = null; // { windows: Map<webContents, {win, capture}>, mainWin, wasVisible, wasMinimized, timer }
	#snipWired = false;
	#onLanguageChange = null;

	constructor(getWindow, onLanguageChange = null) {
		this.#getWindow = getWindow;
		this.#onLanguageChange = onLanguageChange;
		this.#readyPromise = new Promise((resolve) => {
			this.#readyResolve = resolve;
		});
	}

	/** Resolves once the initial session is bound; used to gate IPC. */
	get ready() {
		return this.#readyPromise;
	}

	isShuttingDown() {
		return this.#shuttingDown;
	}

	markShuttingDown() {
		this.#shuttingDown = true;
	}

	get session() {
		return this.#runtime?.session;
	}

	get runtime() {
		return this.#runtime;
	}

	send(channel, payload) {
		const win = this.#getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	async start({ cwd, sessionPath, explicitCwd = false }) {
		this.registerIpc();
		this.#explicitCwd = explicitCwd;
		this.#modelRuntime = await ModelRuntime.create();

		const initialServices = await createAgentSessionServices({
			cwd,
			modelRuntime: this.#modelRuntime,
		});

		const factory = async ({ cwd: nextCwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext }) => {
			const services = await createAgentSessionServices({
				cwd: nextCwd,
				agentDir,
				modelRuntime: this.#modelRuntime,
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
			});
			return {
				...result,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const initialSessionManager = sessionPath
			? SessionManager.open(sessionPath, undefined, cwd)
			: SessionManager.create(cwd);

		this.#runtime = await createAgentSessionRuntime(factory, {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: initialSessionManager,
			sessionStartEvent: { type: "session_start", reason: "start", previousSessionFile: undefined },
		});

		await this.bindCurrentSession();
		this.send("host:ready", await this.snapshot());
		this.#readyResolve?.();
	}

	async shutdown() {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		try {
			if (this.#unsubscribeSession) {
				this.#unsubscribeSession();
				this.#unsubscribeSession = null;
			}
			if (this.#runtime) {
				await this.#runtime.dispose();
				this.#runtime = null;
			}
			for (const [id, res] of this.#uiRequests) {
				res({ value: undefined, cancelled: true });
				this.#uiRequests.delete(id);
			}
			for (const [id, res] of this.#authRequests) {
				res({ value: undefined, cancelled: true });
				this.#authRequests.delete(id);
			}
		} finally {
			ipcMain.removeHandler("pi:invoke");
		}
	}

	async reconfigure({ cwd, sessionPath }) {
		if (!cwd) return { error: t("host.noFolder") };
		try {
			const previous = this.#runtime;
			if (previous) {
				if (this.#unsubscribeSession) {
					this.#unsubscribeSession();
					this.#unsubscribeSession = null;
				}
				await previous.dispose();
				this.#runtime = null;
			}
			const factoryCwd = cwd;
			const factory = async ({ cwd: nextCwd, agentDir, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd: nextCwd,
					agentDir,
					modelRuntime: this.#modelRuntime,
				});
				const result = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				});
				return { ...result, services, diagnostics: services.diagnostics };
			};
			const sessionManager = sessionPath
				? SessionManager.open(sessionPath, undefined, factoryCwd)
				: SessionManager.create(factoryCwd);
			this.#runtime = await createAgentSessionRuntime(factory, {
				cwd: factoryCwd,
				agentDir: getAgentDir(),
				sessionManager,
			});
			await this.bindCurrentSession();
			this.send("host:ready", await this.snapshot());
			this.#readyResolve?.();
			return { ok: true };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	// =========================================================================
	// Session binding + event forwarding
	// =========================================================================

	async bindCurrentSession() {
		const session = this.session;
		if (this.#unsubscribeSession) {
			this.#unsubscribeSession();
			this.#unsubscribeSession = null;
		}
		this.#unsubscribeSession = session.subscribe((event) => {
			this.send("agent:event", event);
		});
		try {
			await session.bindExtensions({
				uiContext: this.#makeUiContext(),
				mode: "tui",
				abortHandler: () => {},
				onError: (error) => {
					this.send("host:notify", {
						message: `Extension error: ${error instanceof Error ? error.message : String(error)}`,
						type: "error",
					});
				},
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: async (options) => {
						return await this.#runtime.newSession(options);
					},
					fork: async (entryId, options) => {
						return await this.#runtime.fork(entryId, options);
					},
					navigateTree: async (targetId, options) => {
						return await session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
					},
					sendToSession: async (text) => {
						await session.prompt(text);
					},
				},
			});
		} catch (error) {
			this.send("host:notify", {
				message: `Failed to bind extensions: ${error instanceof Error ? error.message : String(error)}`,
				type: "warning",
			});
		}
	}

	async sessionReplaced() {
		await this.bindCurrentSession();
		this.send("host:session-replaced", await this.snapshot());
	}

	// =========================================================================
	// Snapshot
	// =========================================================================

	settingsSnapshot() {
		const s = this.session?.settingsManager;
		if (!s) return {};
		const pick = (get) => {
			try {
				return get();
			} catch {
				return undefined;
			}
		};
		return {
			theme: pick(() => s.getTheme()),
			defaultProvider: pick(() => s.getDefaultProvider()),
			defaultModel: pick(() => s.getDefaultModel()),
			defaultThinkingLevel: pick(() => s.getDefaultThinkingLevel()),
			steeringMode: pick(() => s.getSteeringMode()),
			followUpMode: pick(() => s.getFollowUpMode()),
			compaction: pick(() => s.getCompactionSettings()),
			branchSummary: pick(() => s.getBranchSummarySettings()),
			retry: pick(() => s.getRetrySettings()),
			httpIdleTimeoutMs: pick(() => s.getHttpIdleTimeoutMs()),
			hideThinkingBlock: pick(() => s.getHideThinkingBlock()),
			showCacheMissNotices: pick(() => s.getShowCacheMissNotices()),
			quietStartup: pick(() => s.getQuietStartup()),
			collapseChangelog: pick(() => s.getCollapseChangelog()),
			showImages: pick(() => s.getShowImages()),
			blockImages: pick(() => s.getBlockImages()),
			imageAutoResize: pick(() => s.getImageAutoResize()),
			enabledModels: pick(() => s.getEnabledModels()),
			defaultTools: pick(() => s.getDefaultTools()),
			doubleEscapeAction: pick(() => s.getDoubleEscapeAction()),
			treeFilterMode: pick(() => s.getTreeFilterMode()),
			externalEditorCommand: pick(() => s.getExternalEditorCommand()),
			shellPath: pick(() => s.getShellPath()),
			shellCommandPrefix: pick(() => s.getShellCommandPrefix()),
			enableSkillCommands: pick(() => s.getEnableSkillCommands()),
		};
	}

	async snapshot() {
		const session = this.session;
		const runtime = this.#runtime;
		const sm = session?.settingsManager;
		const loader = runtime?.services?.resourceLoader;
		const models = this.#modelRuntime.getModels();
		const available = new Set(this.#modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
		return {
			cwd: runtime?.cwd,
			agentDir: runtime?.services?.agentDir,
			platform: process.platform,
			shell: shellConfigForPlatform(process.platform).name,
			// true when the user picked a workspace (CLI --cwd/--session);
			// the renderer skips the startup workspace picker in that case
			explicitCwd: this.#explicitCwd,
			smoke: process.argv.includes("--smoke"),
			sessionId: session?.sessionId,
			sessionFile: session?.sessionFile,
			sessionName: session?.sessionName,
			model: session?.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : undefined,
			thinkingLevel: session?.thinkingLevel,
			thinkingLevels: session?.getAvailableThinkingLevels?.() ?? THINKING_LEVELS,
			isStreaming: session?.isStreaming,
			isCompacting: session?.isCompacting,
			isBashRunning: session?.isBashRunning,
			isRetrying: session?.isRetrying,
			retryAttempt: session?.retryAttempt,
			systemPrompt: session?.systemPrompt,
			messages: session?.messages ?? [],
			activeTools: session?.getActiveToolNames?.() ?? [],
			tools: (session?.getAllTools?.() ?? []).map((t) => ({ name: t.name, description: t.description, isCustom: !["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(t.name) })),
			scopedModels: (session?.scopedModels ?? []).map((s) => ({ provider: s.model.provider, id: s.model.id, thinkingLevel: s.thinkingLevel })),
			stats: session?.getSessionStats?.(),
			contextUsage: session?.getContextUsage?.(),
			queue: {
				steering: session?.getSteeringMessages?.() ?? [],
				followUp: session?.getFollowUpMessages?.() ?? [],
			},
			autoCompaction: session?.autoCompactionEnabled,
			autoRetry: session?.autoRetryEnabled,
			gitBranch: await gitBranchCached(runtime?.cwd ?? process.cwd()),
			models: models.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				cost: m.cost,
				reasoning: m.reasoning,
				available: available.has(`${m.provider}/${m.id}`),
			})),
			extensionCommands: (session?.extensionRunner?.getRegisteredCommands?.() ?? []).map((c) => ({
				name: c.invocationName ?? c.name,
				description: c.description,
			})),
			providers: this.#modelRuntime.getProviders().map((p) => ({
				id: p.id,
				name: p.name,
				auth: p.auth ? Object.keys(p.auth) : [],
			})),
			settings: this.settingsSnapshot(),
			themes: loader ? this.#themeNames(loader) : [],
			resources: loader
				? {
						prompts: (loader.getPrompts()?.prompts ?? []).map((p) => ({ name: p.name, description: p.description, source: p.source })),
						skills: (loader.getSkills()?.skills ?? []).map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath })),
						extensions: (loader.getExtensions()?.extensions ?? []).map((e) => ({ name: e.name, path: e.path ?? e.sourcePath })),
						extensionErrors: (loader.getExtensions()?.errors ?? []).map((e) => ({ path: e.path, error: e.error })),
						contextFiles: (loader.getAgentsFiles?.()?.agentsFiles ?? []).map((f) => f.path),
					}
				: {},
			diagnostics: runtime?.diagnostics ?? [],
			modelFallbackMessage: runtime?.modelFallbackMessage,
		};
	}

	// ---------------------------------------------------------------- themes
	//
	// pi themes are JSON color palettes (see theme-schema.json). We resolve
	// them to CSS custom properties so custom themes restyle the whole UI.

	#builtinThemesDir() {
		const dir = path.join(getPackageDir(), "dist", "modes", "interactive", "theme");
		return fs.existsSync(dir) ? dir : null;
	}

	#themeList() {
		const files = [];
		const seen = new Set();
		const add = (dir, builtin) => {
			if (!dir || !fs.existsSync(dir)) return;
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".json") || f === "theme-schema.json") continue;
				const name = f.slice(0, -5);
				if (seen.has(name)) continue;
				seen.add(name);
				files.push({ name, path: path.join(dir, f), builtin });
			}
		};
		add(this.#builtinThemesDir(), true);
		add(path.join(getAgentDir(), "themes"), false);
		return files.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Resolve a theme file {path} to CSS custom properties. */
	#themeToCssVars(file) {
		let json;
		try {
			json = JSON.parse(fs.readFileSync(file.path, "utf8"));
		} catch {
			return null;
		}
		return resolveThemeToCssVars(json);
	}

	#themeNames(loader) {
		const loaderNames = (loader.getThemes()?.themes ?? [])
			.map((t) => (typeof t === "string" ? t : t.name ?? path.basename(t.path)))
			.filter(Boolean);
		const names = this.#themeList().map((t) => t.name);
		return [...new Set([...names, ...loaderNames])];
	}

	// =========================================================================
	// IPC registration
	// =========================================================================

	registerIpc() {
		ipcMain.handle("pi:invoke", async (_event, channel, params) => {
			try {
				if (typeof channel !== "string" || !IPC_CHANNELS.has(channel)) {
					throw new Error(`Unknown channel: ${channel}`);
				}
				// gate on startup so early renderer calls never race the session
				await this.ready;
				return { ok: true, result: await this.dispatch(channel, params ?? {}) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		});
	}

	async dispatch(channel, params) {
		const s = this.session;
		const rt = this.#runtime;
		const mr = this.#modelRuntime;
		switch (channel) {
			// --- host state (pull-based; covers the race where the renderer
			// loads after the one-shot host:ready push) ---
			case "host.snapshot":
				return await this.snapshot();
			// --- i18n ---
			case "i18n.setLanguage": {
				setUiLanguage(params.language);
				this.#onLanguageChange?.(getUiLanguage());
				return { ok: true, language: getUiLanguage() };
			}
			// --- prompting ---
			case "session.prompt":
				await s.prompt(params.text, {
					images: params.images,
					streamingBehavior: params.streamingBehavior,
				});
				return { ok: true };
			case "session.steer":
				await s.steer(params.text, params.images);
				return { ok: true };
			case "session.followUp":
				await s.followUp(params.text, params.images);
				return { ok: true };
			case "session.abort":
				await s.abort();
				return { ok: true };
			case "session.waitForIdle":
				await s.waitForIdle();
				return { ok: true };
			case "session.queue.clear":
				return s.clearQueue();

			// --- compaction / retry ---
			case "session.compact":
				return await s.compact(params.instructions);
			case "session.compact.abort":
				s.abortCompaction();
				return { ok: true };
			case "session.compaction.setAuto":
				s.setAutoCompactionEnabled(!!params.enabled);
				return { ok: true };
			case "session.retry.setAuto":
				s.setAutoRetryEnabled(!!params.enabled);
				return { ok: true };
			case "session.retry.abort":
				s.abortRetry();
				return { ok: true };
			case "session.steeringMode":
				s.setSteeringMode(params.mode);
				return { ok: true };
			case "session.followUpMode":
				s.setFollowUpMode(params.mode);
				return { ok: true };

			// --- model / thinking ---
			case "session.model.set": {
				const model = mr.getModel(params.provider, params.id);
				if (!model) throw new Error(t("host.modelNotFound", { model: `${params.provider}/${params.id}` }));
				await s.setModel(model);
				return { ok: true, model: { provider: model.provider, id: model.id } };
			}
			case "session.model.cycle": {
				const result = await s.cycleModel(params.backward ? -1 : 1);
				return result ?? { ok: true };
			}
			case "session.thinking.set":
				s.setThinkingLevel(params.level);
				return { ok: true, level: s.thinkingLevel };
			case "session.thinking.cycle":
				s.cycleThinkingLevel();
				return { ok: true, level: s.thinkingLevel };
			case "session.scope.set": {
				const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(
					params.patterns ?? [],
					mr,
				);
				s.setScopedModels(scopedModels);
				return {
					ok: true,
					diagnostics: diagnostics.map((d) => d.message),
					models: scopedModels.map((m) => ({ provider: m.model.provider, id: m.model.id, thinkingLevel: m.thinkingLevel })),
				};
			}

			// --- tools ---
			case "session.tools.set":
				s.setActiveToolsByName(params.names ?? []);
				return { ok: true, active: s.getActiveToolNames() };
			case "session.tools.list":
				return (s.getAllTools() ?? []).map((t) => ({ name: t.name, description: t.description }));

			// --- user bash (!) ---
			case "session.bash.run":
				return await s.executeBash(params.command, undefined, { excludeFromContext: Boolean(params.excludeFromContext) });
			case "session.bash.abort":
				s.abortBash();
				return { ok: true };
			case "session.bash.record":
				s.recordBashResult(params.command, params.result, { excludeFromContext: params.excludeFromContext });
				return { ok: true };

			// --- tree navigation / branching ---
			case "session.navigateTree":
				return await s.navigateTree(params.targetId, {
					summarize: params.summarize,
					customInstructions: params.customInstructions,
					replaceInstructions: params.replaceInstructions,
					label: params.label,
				});
			case "session.forkMessages":
				return s.getUserMessagesForForking();

			// --- session lifecycle ---
			case "session.new": {
				const result = await rt.newSession();
				await this.sessionReplaced();
				return result;
			}
			case "session.resume": {
				const result = await rt.switchSession(params.path, { cwdOverride: params.cwdOverride });
				await this.sessionReplaced();
				return result;
			}
			case "session.fork": {
				const result = await rt.fork(params.entryId, { position: params.position ?? "before" });
				await this.sessionReplaced();
				return result;
			}
			case "session.import": {
				const result = await rt.importFromJsonl(params.path, params.cwdOverride);
				await this.sessionReplaced();
				return result;
			}
			case "session.name.set":
				s.setSessionName(params.name);
				return { ok: true, name: s.sessionName };
			case "session.reload":
				await s.reload();
				await this.sessionReplaced();
				return { ok: true };
			case "session.messages":
				return s.messages;
			case "session.stats":
				return s.getSessionStats();
			case "session.contextUsage":
				return s.getContextUsage();
			case "session.lastAssistantText":
				return s.getLastAssistantText();
			case "session.systemPrompt":
				return s.systemPrompt;

			// --- export ---
			case "session.exportHtml":
				return await s.exportToHtml(params.path, { themeName: params.themeName });
			case "session.exportJsonl":
				return s.exportToJsonl(params.path);

			// --- session files ---
			case "sessions.list": {
				// listAll's optional string arg is a session *directory*, not a cwd;
				// no arg = all project directories under the agent sessions dir.
				// params.cwd lists one workspace's sessions (workspace picker);
				// without it, the live runtime's cwd.
				const targetCwd = params.cwd ? path.resolve(params.cwd) : rt.cwd;
				const list = params.all ? SessionManager.listAll() : SessionManager.list(targetCwd);
				// compare against the live runtime's session file: `s` is a stale
				// reference once the session has been switched/reconfigured
				const currentFile = this.runtime?.session?.sessionFile ?? s?.sessionFile;
				return (await list).map((info) => ({ ...this.#sessionInfoFor(info), isCurrent: info.path === currentFile }));
			}
			case "sessions.delete": {
				// validate: only .jsonl files under the agent sessions directory
				// (never the live session file)
				const sessionsDir = path.join(getAgentDir(), "sessions");
				const target = params.path ? path.resolve(params.path) : "";
				const rel = path.relative(sessionsDir, target);
				if (
					!target ||
					!target.toLowerCase().endsWith(".jsonl") ||
					rel.startsWith("..") ||
					path.isAbsolute(rel)
				) {
					throw new Error(t("host.refusingDeleteSession"));
				}
				// win32 paths are case-insensitive — compare normalized
				const currentFile = s.sessionFile ? path.resolve(s.sessionFile) : "";
				const same = currentFile &&
					(target.toLowerCase() === currentFile.toLowerCase());
				if (same) throw new Error(t("host.cannotDeleteCurrentSession"));
				if (fs.existsSync(target)) fs.unlinkSync(target);
				return { ok: true };
			}
			case "sessions.tree": {
				const sm = s.sessionManager;
				const entries = sm.getEntries().map((e) => this.#entryForTree(e));
				return {
					entries,
					leafId: sm.getLeafEntry()?.id,
					// SessionManager has no getPath(); getBranch() walks leaf -> root
					path: sm.getBranch().map((e) => e.id),
					labels: Object.fromEntries(entries.filter((e) => e.label).map((e) => [e.id, e.label])),
				};
			}
			case "sessions.setLabel": {
				s.sessionManager.appendLabelChange(params.entryId, params.label);
				return { ok: true };
			}

			// --- workspaces (a workspace is a directory / agent cwd) ---
			case "workspaces.list": {
				const sessions = await SessionManager.listAll();
				return groupWorkspaces(sessions, { currentCwd: this.runtime?.cwd ?? "" });
			}
			case "workspaces.delete": {
				const cwd = params.cwd ? path.resolve(params.cwd) : "";
				if (!cwd) throw new Error(t("host.noWorkspace"));
				const currentCwd = this.runtime?.cwd ? path.resolve(this.runtime.cwd) : "";
				if (currentCwd && cwd.toLowerCase() === currentCwd.toLowerCase()) {
					throw new Error(t("host.cannotDeleteCurrentWorkspace"));
				}
				const dir = sessionDirForCwd(cwd);
				// safety: the encoded dir must live under the agent sessions dir
				const sessionsRoot = path.join(getAgentDir(), "sessions");
				const rel = path.relative(sessionsRoot, dir);
				if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
					throw new Error(t("host.refusingDeleteWorkspace"));
				}
				let deleted = 0;
				if (fs.existsSync(dir)) {
					const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
					for (const f of files) {
						fs.unlinkSync(path.join(dir, f));
						deleted++;
					}
					try {
						if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
					} catch {
						// leave the (non-empty or locked) dir in place
					}
				}
				return { ok: true, deleted };
			}

			// --- models / auth ---
			case "models.list":
				return (this.#runtime ? await this.snapshot() : {}).models;
			case "models.refresh":
				return await mr.refresh({ allowNetwork: true, force: true });
			case "models.authStatus": {
				const providers = mr.getProviders().map((p) => {
					let status = "unknown";
					try {
						status = mr.getProviderAuthStatus(p.id);
					} catch {
						// leave unknown
					}
					return { id: p.id, name: p.name, status };
				});
				const credentials = await mr.listCredentials();
				return { providers, credentials: credentials.map((c) => ({ providerId: c.providerId, type: c.type, source: c.source ?? undefined })) };
			}
			case "models.login":
				return await this.#runLogin(params.providerId, params.method ?? "oauth");
			case "models.logout":
				await mr.logout(params.providerId);
				await this.#afterAuthChange();
				return { ok: true };
			case "models.apiKey.set":
				await mr.setRuntimeApiKey(params.providerId, params.key);
				await this.#afterAuthChange();
				return { ok: true };
			case "models.apiKey.remove":
				await mr.removeRuntimeApiKey(params.providerId);
				await this.#afterAuthChange();
				return { ok: true };

			// --- custom providers (global models.json) ---
			case "models.config.read": {
				const p = path.join(getAgentDir(), "models.json");
				let text = "";
				try {
					text = fs.readFileSync(p, "utf8");
				} catch {
					// file does not exist yet
				}
				const parsed = parseModelsJson(text);
				return { path: p, providers: parsed.providers, error: parsed.error };
			}
			case "models.config.save": {
				const providers = params.providers;
				if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
					throw new Error(t("host.providersInvalid"));
				}
				const p = path.join(getAgentDir(), "models.json");
				fs.mkdirSync(path.dirname(p), { recursive: true });
				fs.writeFileSync(p, serializeModelsJson(providers), "utf8");
				await this.#afterAuthChange();
				return { ok: true, path: p };
			}

			// --- misc host ---
			case "resources.changelog": {
				try {
					const changelogPath = path.join(getPackageDir(), "CHANGELOG.md");
					return fs.readFileSync(changelogPath, "utf8");
				} catch {
					return undefined;
				}
			}

			// --- resources / settings / themes ---
			case "theme.list":
				return this.#themeList();
			case "theme.css": {
				const file = this.#themeList().find((t) => t.name === params.name);
				if (!file) return { error: `Unknown theme: ${params.name}` };
				const vars = this.#themeToCssVars(file);
				if (!vars) return { error: `Failed to parse theme: ${params.name}` };
				return { name: file.name, builtin: file.builtin, vars };
			}
			case "resources.get": {
				const loader = rt.services.resourceLoader;
				return {
					prompts: (loader.getPrompts()?.prompts ?? []).map((p) => ({ name: p.name, description: p.description, source: p.source })),
					skills: (loader.getSkills()?.skills ?? []).map((sk) => ({ name: sk.name, description: sk.description, source: sk.source, filePath: sk.filePath })),
					extensions: (loader.getExtensions()?.extensions ?? []).map((e) => ({ name: e.name, path: e.path ?? e.sourcePath })),
					extensionErrors: (loader.getExtensions()?.errors ?? []).map((e) => ({ path: e.path, error: e.error })),
					contextFiles: (loader.getAgentsFiles?.()?.agentsFiles ?? []).map((f) => ({ path: f.path, content: f.content })),
				};
			}
			case "settings.get":
				return this.settingsSnapshot();
			case "settings.set":
				return await this.#setSetting(params.key, params.value);

			// --- trust ---
			case "trust.get":
				return { trusted: s.settingsManager.isProjectTrusted() };
			case "trust.set":
				s.settingsManager.setProjectTrusted(!!params.trusted);
				return { ok: true, trusted: !!params.trusted };

			// --- system ---
			case "system.platform":
				return {
					platform: process.platform,
					shell: shellConfigForPlatform(process.platform).name,
					gitBranch: await gitBranchCached(rt.cwd),
					nativeTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
				};
			case "system.pickDirectory": {
				const win = this.#getWindow();
				const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
				return result.canceled ? undefined : result.filePaths[0];
			}
			case "system.pickFile": {
				const win = this.#getWindow();
				const result = await dialog.showOpenDialog(win, {
					properties: ["openFile"],
					filters: params.filters,
				});
				return result.canceled ? undefined : result.filePaths[0];
			}
			case "system.readFileBase64": {
				const stat = fs.statSync(params.path);
				if (stat.size > MAX_READ_BASE64_BYTES) {
					throw new Error(t("host.fileTooLarge", { mb: MAX_READ_BASE64_BYTES / 1024 / 1024 }));
				}
				const buffer = fs.readFileSync(params.path);
				const mime = detectSupportedImageMimeTypeFromFile(params.path);
				if (!mime) throw new Error(t("host.notImage"));
				return { mime, data: buffer.toString("base64") };
			}
			case "system.fs.list":
				return this.#listFilesForCompletion(params.prefix);
			case "system.clipboard.write":
				clipboard.writeText(params.text);
				return { ok: true };
			case "system.clipboard.readImage": {
				const image = clipboard.readImage();
				if (image.isEmpty()) return undefined;
				const png = image.toPNG().toString("base64");
				return { mime: "image/png", data: png };
			}
			// --- screen capture ---
			case "system.displays": {
				const displays = screen.getAllDisplays();
				const primary = screen.getPrimaryDisplay();
				return displays.map((d, i) => ({
					index: i,
					name: d.label || t("host.screen", { n: i + 1 }),
					width: d.size.width,
					height: d.size.height,
					isPrimary: d.id === primary.id,
				}));
			}
			case "system.screenshot": {
				const captures = await this.#captureAllDisplays();
				const index = Math.max(0, Math.min(params?.index ?? 0, captures.length - 1));
				const { image } = captures[index];
				const dataUrl = image.toDataURL();
				const comma = dataUrl.indexOf(",");
				const mime = /data:([^;]+)/.exec(dataUrl)?.[1] ?? "image/png";
				const size = image.getSize();
				return {
					data: dataUrl.slice(comma + 1),
					mime,
					width: size.width,
					height: size.height,
					name: t("host.screen", { n: index + 1 }),
				};
			}
			case "system.screenshot.start":
				return await this.startSnip();
			case "system.openExternal":
				if (/^https?:/i.test(params.url)) {
					await shell.openExternal(params.url);
				}
				return { ok: true };
			case "system.openPath":
				if (params.path && fs.existsSync(params.path)) {
					await shell.openPath(params.path);
				}
				return { ok: true };
			case "system.revealPath":
				if (params.path && fs.existsSync(params.path)) {
					shell.showItemInFolder(params.path);
				}
				return { ok: true };
			case "system.reconfigure":
				return await this.reconfigure(params);
			case "system.appInfo":
				return {
					appVersion: app.getVersion(),
					version: process.versions.electron ? `electron ${process.versions.electron}` : "",
					node: process.version,
					platform: process.platform,
				};

			// --- extension ui ---
			case "ext.ui.respond": {
				const res = this.#uiRequests.get(params.id);
				if (res) {
					this.#uiRequests.delete(params.id);
					res({ value: params.value, cancelled: !!params.cancelled });
				}
				return { ok: true };
			}
			case "ext.editor.cache":
				this.#lastEditorText = params.text ?? "";
				return { ok: true };
			case "auth.respond": {
				const res = this.#authRequests.get(params.id);
				if (res) {
					this.#authRequests.delete(params.id);
					res({ value: params.value, cancelled: !!params.cancelled });
				}
				return { ok: true };
			}

			default:
				throw new Error(`Unknown channel: ${channel}`);
		}
	}

	#sessionInfoFor(info) {
		// SDK SessionInfo fields: path, id, cwd, name?, parentSessionPath?,
		// created, modified, messageCount, firstMessage, allMessagesText
		return {
			path: info.path,
			cwd: info.cwd ?? "",
			name: info.name,
			created: info.created,
			updated: info.modified,
			title: info.firstMessage,
			messageCount: info.messageCount,
		};
	}

	#entryForTree(entry) {
		let text = "";
		let role = undefined;
		if (entry.type === "message" && entry.message) {
			role = entry.message.role;
			const c = entry.message.content;
			if (typeof c === "string") text = c;
			else if (Array.isArray(c)) {
				text = c
					.filter((part) => part.type === "text" || part.type === "toolCall")
					.map((part) => (part.type === "text" ? part.text : `[${part.name}]`))
					.join(" ");
			}
		} else if (entry.type === "compaction") {
			role = "compaction";
			text = entry.summary ?? "";
		} else if (entry.type === "branch_summary") {
			role = "branchSummary";
			text = entry.summary ?? "";
		} else if (entry.type === "custom_message") {
			role = "custom";
			const c = entry.content;
			text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => p.text).join(" ") : "";
		} else if (entry.type === "model_change") {
			role = "model";
			text = `${entry.provider}/${entry.modelId}`;
		} else if (entry.type === "thinking_level_change") {
			role = "thinking";
			text = entry.thinkingLevel;
		} else if (entry.type === "label") {
			role = "label";
			text = entry.label ?? "";
		} else {
			role = entry.type;
		}
		return {
			id: entry.id,
			parentId: entry.parentId,
			type: entry.type,
			role,
			text: (text || "").slice(0, 200),
			timestamp: entry.timestamp,
			label: entry.label,
		};
	}

// --- screen-region snip (selection overlay) ---

	/**
	 * Capture every display at (near) physical resolution.
	 * desktopCapturer needs an explicit thumbnailSize — {0,0} "native" can
	 * yield empty thumbnails on some Windows setups. We request the largest
	 * display's physical size; smaller displays fit inside and are captured
	 * at native resolution. Source order matches getAllDisplays().
	 */
	async #captureAllDisplays() {
		const displays = screen.getAllDisplays();
		if (!displays.length) throw new Error(t("host.noScreens"));
		let maxW = 1;
		let maxH = 1;
		for (const d of displays) {
			maxW = Math.max(maxW, Math.round(d.size.width * d.scaleFactor));
			maxH = Math.max(maxH, Math.round(d.size.height * d.scaleFactor));
		}
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize: { width: maxW, height: maxH },
			fetchWindowThumbnails: false,
		});
		const out = [];
		for (let i = 0; i < displays.length; i++) {
			const source = sources[i] ?? sources[0];
			const image = source?.thumbnail;
			if (!image || image.isEmpty()) throw new Error("Screen capture failed (empty image)");
			const size = image.getSize();
			out.push({
				display: displays[i],
				image,
				imgW: size.width,
				imgH: size.height,
			});
		}
		return out;
	}

	/**
	 * Interactive screen-region capture: hide the app window, capture all
	 * displays, open a fullscreen transparent overlay per display where the
	 * user drags a rectangle. The crop is pushed to the main window as a
	 * "screenshot:preview" payload; the main window shows the preview modal.
	 */
	async startSnip() {
		if (this.#snipState) return { error: t("host.snipBusy") };
		this.#ensureSnipHandlers();
		const mainWin = this.#getWindow();
		const alive = mainWin && !mainWin.isDestroyed();
		const wasVisible = alive ? mainWin.isVisible() : false;
		const wasMinimized = alive ? mainWin.isMinimized() : false;
		// Hide the app so it does not appear in the capture
		if (alive && wasVisible) mainWin.hide();
		// Give the compositor a moment to actually hide the window
		await new Promise((r) => setTimeout(r, 150));
		let captures;
		try {
			captures = await this.#captureAllDisplays();
		} catch (err) {
			if (alive && wasVisible && !mainWin.isVisible()) mainWin.show();
			throw err;
		}
		// Windows clamps window sizes to the primary work area (SM_*MAXTRACK)
		// unless the maximum size is raised first.
		let maxW = 1;
		let maxH = 1;
		for (const c of captures) {
			maxW = Math.max(maxW, c.display.size.width);
			maxH = Math.max(maxH, c.display.size.height);
		}
		maxW += 64;
		maxH += 64;
		const windows = new Map();
		for (let i = 0; i < captures.length; i++) {
			const capture = captures[i];
			const { display } = capture;
			const win = new BrowserWindow({
				x: display.bounds.x,
				y: display.bounds.y,
				width: display.size.width,
				height: display.size.height,
				frame: false,
				transparent: true,
				backgroundColor: "#00000000",
				alwaysOnTop: true,
				resizable: false,
				movable: false,
				hasShadow: false,
				skipTaskbar: true,
				show: false,
				webPreferences: {
					preload: path.join(import.meta.dirname, "..", "preload", "snip.js"),
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: false,
				},
			});
			win.setAlwaysOnTop(true, "screen-saver");
			win.setMaximumSize(maxW, maxH);
			await win.loadFile(path.join(import.meta.dirname, "..", "renderer", "snip.html"));
			win.webContents.send("snip:init", {
				data: capture.image.toPNG().toString("base64"),
				mime: "image/png",
				imgW: capture.imgW,
				imgH: capture.imgH,
				lang: getUiLanguage(),
			});
			win.show();
			// Re-apply the bounds after show: Windows clamps oversized windows
			// to the primary work area at creation; setBounds after show sticks.
			win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: display.size.width, height: display.size.height });
			windows.set(win.webContents, { win, capture });
		}
		this.#snipState = {
			windows,
			mainWin: alive ? mainWin : null,
			wasVisible,
			wasMinimized,
			timer: setTimeout(() => this.#finishSnip(), 120_000),
		};
		return { ok: true, displays: captures.length };
	}

	#ensureSnipHandlers() {
		if (this.#snipWired) return;
		this.#snipWired = true;
		ipcMain.on("snip:select", (event, rect) => {
			const st = this.#snipState;
			if (!st || !st.windows.has(event.sender)) return;
			const { capture } = st.windows.get(event.sender);
			// The overlay already reports the rect in image pixels (scaled
			// with its actual window size); here we only validate and clamp.
			const crop = isValidRect(rect) ? clampCrop(rect, capture.imgW, capture.imgH) : null;
			const preview =
				crop &&
				(() => {
					try {
						const cropped = capture.image.crop({ x: crop.x, y: crop.y, width: crop.w, height: crop.h });
						if (!cropped || cropped.isEmpty()) return null;
						const size = cropped.getSize();
						return { data: cropped.toPNG().toString("base64"), mime: "image/png", width: size.width, height: size.height };
					} catch {
						return null;
					}
				})();
			this.#finishSnip();
			if (preview) {
				// finishSnip already restored the main window; push the preview
				const mw = this.#getWindow();
				if (mw && !mw.isDestroyed()) {
					mw.webContents.send("screenshot:preview", preview);
				}
			}
		});
		ipcMain.on("snip:cancel", (event) => {
			const st = this.#snipState;
			if (!st || !st.windows.has(event.sender)) return;
			this.#finishSnip();
		});
	}

	#finishSnip() {
		const st = this.#snipState;
		if (!st) return;
		this.#snipState = null;
		clearTimeout(st.timer);
		for (const { win } of st.windows.values()) {
			if (!win.isDestroyed()) win.destroy();
		}
		if (st.mainWin && !st.mainWin.isDestroyed()) {
			if (st.wasMinimized) st.mainWin.restore();
			else if (st.wasVisible) st.mainWin.show();
			if (st.wasVisible) st.mainWin.focus();
		}
	}

	#listFilesForCompletion(prefix) {
		const cwd = this.#runtime?.cwd ?? process.cwd();
		if (!prefix || prefix.length > 512) return [];
		try {
			const base = prefix.startsWith("/") ? path.join(cwd, prefix.slice(1)) : path.join(cwd, prefix);
			const dir = path.dirname(base);
			const namePart = path.basename(base);
			if (!fs.existsSync(dir)) return [];
			const out = new Set();
			const walk = (dirPath, depth) => {
				if (depth > 3 || out.size >= 200) return;
				let items;
				try {
					items = fs.readdirSync(dirPath, { withFileTypes: true });
				} catch {
					return;
				}
				for (const item of items) {
					if (out.size >= 200) return;
					if (item.name.startsWith(".") || ["node_modules", ".git"].includes(item.name)) continue;
					if (!item.name.toLowerCase().startsWith(namePart.toLowerCase())) {
						if (item.isDirectory()) walk(path.join(dirPath, item.name), depth + 1);
						continue;
					}
					const rel = "/" + path.relative(cwd, path.join(dirPath, item.name)).replace(/\\/g, "/");
					out.add(rel);
				}
			};
			walk(dir, 0);
			return [...out].sort().slice(0, 100);
		} catch {
			return [];
		}
	}

	#setSetting(key, value) {
		const s = this.session.settingsManager;
		const set = {
			theme: (v) => s.setTheme(v),
			steeringMode: (v) => s.setSteeringMode(v),
			followUpMode: (v) => s.setFollowUpMode(v),
			compaction: (v) => {
				if (v.enabled !== undefined) s.setCompactionEnabled(v.enabled);
			},
			retry: (v) => {
				if (v.enabled !== undefined) s.setRetryEnabled(v.enabled);
			},
			hideThinkingBlock: (v) => s.setHideThinkingBlock(v),
			showCacheMissNotices: (v) => s.setShowCacheMissNotices(v),
			quietStartup: (v) => s.setQuietStartup(v),
			collapseChangelog: (v) => s.setCollapseChangelog(v),
			showImages: (v) => s.setShowImages(v),
			blockImages: (v) => s.setBlockImages(v),
			imageAutoResize: (v) => s.setImageAutoResize(v),
			doubleEscapeAction: (v) => s.setDoubleEscapeAction(v),
			treeFilterMode: (v) => s.setTreeFilterMode(v),
			enableSkillCommands: (v) => s.setEnableSkillCommands(v),
			externalEditorCommand: (v) => s.setExternalEditorCommand(v),
			defaultThinkingLevel: (v) => s.setDefaultThinkingLevel(v),
			enabledModels: (v) => s.setEnabledModels(v),
			httpIdleTimeoutMs: (v) => s.setHttpIdleTimeoutMs(v),
		};
		const fn = set[key];
		if (!fn) throw new Error(`Unsupported setting: ${key}`);
		fn(value);
		return { ok: true };
	}

	async #afterAuthChange() {
		await this.#modelRuntime.refresh({ allowNetwork: false });
		this.send("host:auth-changed", { ok: true });
	}

	// =========================================================================
	// Login (auth) bridge
	// =========================================================================

	async #runLogin(providerId, method) {
		const controller = new AbortController();
		const interaction = {
			signal: controller.signal,
			prompt: async (prompt) => {
				const id = `auth-${++this.#seq}`;
				const value = await new Promise((resolve) => {
					this.#authRequests.set(id, resolve);
					this.send("auth.prompt", { id, prompt });
				});
				if (value.cancelled) throw new Error(t("host.loginCancelled"));
				return value.value;
			},
			notify: (event) => {
				this.send("auth.notify", { event });
				if (event.type === "auth_url") {
					void shell.openExternal(event.url).catch(() => {});
				}
			},
		};
		try {
			const credential = await this.#modelRuntime.login(providerId, method, interaction);
			await this.#afterAuthChange();
			return { ok: true, credential: { type: credential?.type ?? method, source: credential?.source } };
		} catch (error) {
			controller.abort();
			throw error;
		} finally {
			for (const [id, res] of this.#authRequests) {
				res({ value: undefined, cancelled: true });
				this.#authRequests.delete(id);
			}
		}
	}

	// =========================================================================
	// Extension UI context bridge
	// =========================================================================

	#makeUiContext() {
		const host = this;
		const request = (kind, payload) =>
			new Promise((resolve) => {
				const id = `ui-${++host.#seq}`;
				host.#uiRequests.set(id, resolve);
				host.send("ext.ui.request", { id, kind, ...payload });
			});
		return {
			select: async (title, options, opts) => {
				const res = await request("select", { title, options, opts });
				return res.cancelled ? undefined : res.value;
			},
			confirm: async (title, message, opts) => {
				const res = await request("confirm", { title, message, opts });
				return !res.cancelled && res.value === true;
			},
			input: async (title, placeholder, opts) => {
				const res = await request("input", { title, placeholder, opts });
				return res.cancelled ? undefined : res.value;
			},
			notify: (message, type) => {
				host.send("host:notify", { message, type: type ?? "info" });
			},
			onTerminalInput: () => () => {},
			setStatus: (key, text) => {
				host.send("ext.status", { key, text });
			},
			setWorkingMessage: (message) => {
				host.send("ext.working", { message });
			},
			setWorkingVisible: (visible) => {
				host.send("ext.working", { visible });
			},
			setWorkingIndicator: (options) => {
				host.send("ext.working", { indicator: options });
			},
			setHiddenThinkingLabel: () => {},
			setWidget: (key, content, options) => {
				if (typeof content === "function") return; // TUI component factories are not renderable here
				host.send("ext.widget", { key, lines: content, options });
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => {
				const win = host.#getWindow();
				if (win) win.setTitle(title);
			},
			custom: async () => {
				throw new Error(t("host.customComponentUnsupported"));
			},
			pasteToEditor: (text) => {
				host.send("ext.editor.paste", { text });
			},
			setEditorText: (text) => {
				host.send("ext.editor.setText", { text });
			},
			getEditorText: () => {
				// Synchronous contract; renderer state is cached in main on set.
				return host.#lastEditorText ?? "";
			},
			editor: async (title, prefill) => {
				const res = await request("editor", { title, prefill });
				return res.cancelled ? undefined : res.value;
			},
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
		};
	}
}
