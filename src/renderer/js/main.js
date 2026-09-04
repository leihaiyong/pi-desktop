import { Transcript } from "./transcript.js";
import { Editor } from "./editor.js";
import { BUILTIN_COMMANDS, parseSlashCommand } from "../../shared/slash.js";
import { defaultBindings, buildComboIndex, eventToCombo } from "../../shared/keys.js";
import { formatTokens, formatContextUsage, formatCost, formatTimestamp } from "../../shared/format.js";
import * as modals from "./modals.js";
const { openModalPublic } = modals;
import { openWorkspacePicker } from "./workspaces.js";
import { t, getLanguage, setLanguage, SUPPORTED_LANGUAGES } from "../../shared/i18n.js";

// ---------------------------------------------------------------- state

const state = {
	snapshot: null,
	bindings: {},
	// true between agent_start and agent_end; the snapshot's isStreaming flag
	// only refreshes after agent_settled, so this tracks the in-flight prompt
	agentRunning: false,
	workingMessage: undefined,
	workingVisible: true,
	extensionStatus: new Map(),
	warning: undefined,
	appVersion: undefined,
};

const $ = (sel) => document.querySelector(sel);

const transcriptEl = $("#transcript");
const transcript = new Transcript(transcriptEl, (atBottom) => {});

let toastTimer = null;

function toast(message, type = "info", timeout = 3500) {
	const root = $("#toast-root");
	const el = document.createElement("div");
	el.className = `toast ${type}`;
	el.textContent = message;
	root.appendChild(el);
	setTimeout(() => el.remove(), timeout);
}

// ---------------------------------------------------------------- i18n

const LANG_STORAGE_KEY = "pi.language";

/** Initial language: saved choice, then navigator language, then English. */
function initialLanguage() {
	const saved = localStorage.getItem(LANG_STORAGE_KEY);
	if (saved && SUPPORTED_LANGUAGES.some((l) => l.id === saved)) return saved;
	const nav = (navigator.language || "").toLowerCase();
	if (nav.startsWith("zh")) return "zh";
	return "en";
}

/** Re-render every data-i18n element plus the dynamic button titles/status. */
function applyI18n() {
	document.documentElement.lang = getLanguage();
	for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
	for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
	for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
	for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
	updateThemeButton();
	updateFontButtons();
	updateFooter();
	updateStatus();
	// re-render dynamic, language-dependent chrome (titlebar labels are set
	// from the snapshot, transcript labels are baked into the DOM on render)
	updateTitlebarLabels(state.snapshot);
	transcript.rebuild();
	editor.hideCompletion();
	// close any open modal so untranslated content never lingers
	modals.closeAnyOpenModal();
}

/** Switch UI language: persist, tell the main process, re-render strings. */
async function changeLanguage(lang) {
	if (!SUPPORTED_LANGUAGES.some((l) => l.id === lang)) return;
	if (lang === getLanguage()) return;
	setLanguage(lang);
	localStorage.setItem(LANG_STORAGE_KEY, lang);
	try {
		await window.pi?.invoke("i18n.setLanguage", { language: lang });
	} catch {
		/* main process keeps its previous menu language */
	}
	applyI18n();
	const label = SUPPORTED_LANGUAGES.find((l) => l.id === lang)?.label ?? lang;
	toast(t("app.languageSet", { label }), "info", 2000);
}

// ---------------------------------------------------------------- snapshot

async function applyTheme(themeName) {
	const root = document.documentElement;
	// unset theme → light default
	if (!themeName || themeName === "") {
		applyTheme("light");
		return;
	}
	// built-in themes map straight to CSS data-theme
	if (themeName === "light" || themeName === "dark") {
		root.dataset.theme = themeName;
		root.style.cssText = "";
		applyFontScaleVar(); // cssText reset wipes the inline --fs
		return;
	}
	// auto "lightName/darkName" — pick by the browser color scheme
	if (themeName && themeName.includes("/")) {
		const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
		const [lightName, darkName] = themeName.split("/");
		await applyTheme(prefersLight ? lightName : darkName);
		return;
	}
	// custom theme: fall back to light, then overlay the resolved CSS vars.
	// Clear stale vars first so a theme with fewer keys can't leak values
	// from a previously applied custom theme.
	root.dataset.theme = "light";
	root.style.cssText = "";
	applyFontScaleVar(); // cssText reset wipes the inline --fs
	if (!themeName || themeName === "") return;
	try {
		const res = await invokeSafe("theme.css", { name: themeName });
		if (res?.vars) {
			for (const [k, v] of Object.entries(res.vars)) root.style.setProperty(k, v);
		}
	} catch {
		/* keep the light base */
	}
}

// Effective appearance of the rendered theme ("light" | "dark").
// With no data-theme set the CSS default (light) applies. Custom themes
// render on the light base, so anything that is not the "light"
// data-theme counts as dark. Reading the DOM (not the snapshot)
// keeps this in sync after settings.set, which does not push a new snapshot.
function currentAppearance() {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function updateThemeButton() {
	const btn = $("#tb-theme");
	if (!btn) return;
	const target = currentAppearance() === "light" ? "dark" : "light";
	btn.textContent = target === "light" ? "☀" : "☾";
	btn.title = target === "light" ? t("app.switchToLight") : t("app.switchToDark");
}

// ---------------------------------------------------------------- font size

// Font levels in px relative to the 14px base the CSS was authored with.
// Default is one level above the old 14px default (16px).
const FONT_LEVELS = [12, 14, 16, 18, 20];
const FONT_DEFAULT_INDEX = FONT_LEVELS.indexOf(16);
const FONT_BASE = 14;
const FONT_STORAGE_KEY = "pi.fontLevel";

function fontLevel() {
	const s = localStorage.getItem(FONT_STORAGE_KEY);
	if (s === null) return FONT_DEFAULT_INDEX; // Number(null) is 0 — never a valid sentinel
	const raw = Number(s);
	return Number.isInteger(raw) && raw >= 0 && raw < FONT_LEVELS.length ? raw : FONT_DEFAULT_INDEX;
}

function updateFontButtons() {
	const idx = fontLevel();
	const px = FONT_LEVELS[idx];
	const down = $("#tb-font-down");
	const up = $("#tb-font-up");
	if (down) {
		down.disabled = idx === 0;
		down.title = idx === 0 ? t("app.fontSmallest", { px }) : t("app.fontSmaller", { px });
	}
	if (up) {
		up.disabled = idx === FONT_LEVELS.length - 1;
		up.title = idx === FONT_LEVELS.length - 1 ? t("app.fontLargest", { px }) : t("app.fontLarger", { px });
	}
}

function applyFontScaleVar() {
	// scale factor over the 14px base the stylesheet was authored with
	const idx = fontLevel();
	document.documentElement.style.setProperty("--fs", (FONT_LEVELS[idx] / FONT_BASE).toFixed(4));
}

function setFontLevel(idx) {
	const next = Math.max(0, Math.min(FONT_LEVELS.length - 1, idx));
	localStorage.setItem(FONT_STORAGE_KEY, String(next));
	applyFontScaleVar();
	updateFontButtons();
}

// ---------------------------------------------------------------- workspaces

function openWorkspacePickerUI() {
	const cwd = state.snapshot?.cwd ?? "";
	// close the picker (shared by every "opened something" path)
	const closePicker = () => {
		const root = $("#modal-root");
		if (root._keydownHandler) {
			document.removeEventListener("keydown", root._keydownHandler, { capture: true });
			root._keydownHandler = null;
		}
		root.hidden = true;
		root.innerHTML = "";
	};
	openWorkspacePicker({
		currentCwd: cwd,
		onOpenWorkspace: (wsCwd, done) => {
			// same workspace: nothing to switch to — just close the picker
			if (wsCwd === cwd) {
				closePicker();
				done();
				return;
			}
			void invokeSafe("system.reconfigure", { cwd: wsCwd }).then((res) => {
				if (res?.error) {
					toast(res.error, "error");
					done();
					return;
				}
				// host:ready applies the new snapshot; close the picker
				closePicker();
				toast(t("app.workspaceOpened", { cwd: wsCwd }), "success");
				done();
			});
		},
		onOpenSession: (wsCwd, session, done) => {
			if (wsCwd === cwd) {
				void invokeSafe("session.resume", { path: session.path }).then((res) => {
					if (res?.cancelled) toast(t("app.resumeCancelled"), "warning");
					closePicker();
					done();
				});
				return;
			}
			void invokeSafe("system.reconfigure", { cwd: wsCwd, sessionPath: session.path }).then((res) => {
				if (res?.error) {
					toast(res.error, "error");
					done();
					return;
				}
				closePicker();
				toast(t("app.workspaceOpened", { cwd: wsCwd }), "success");
				done();
			});
		},
		onNewWorkspace: () => {
			void window.pi.invoke("system.pickDirectory").then((dir) => {
				if (!dir) return;
				if (dir === cwd) {
					toast(t("app.alreadyInWorkspace"), "info");
					return;
				}
				void invokeSafe("system.reconfigure", { cwd: dir }).then((res) => {
					if (res?.error) {
						toast(res.error, "error");
						return;
				}
					closePicker();
					toast(`Workspace: ${dir}`, "success");
				});
			});
		},
	});
}

/** Patch the displayed model (and thinking level) after a model change that
 *  does not come with a fresh snapshot: the SDK emits no model-changed event,
 *  so the titlebar/footer would otherwise keep showing the old model. */
function setModelInUi(model, thinkingLevel) {
	if (!state.snapshot) return;
	if (model) state.snapshot.model = { provider: model.provider, id: model.id, name: model.name };
	if (thinkingLevel) state.snapshot.thinkingLevel = thinkingLevel;
	updateTitlebarLabels(state.snapshot);
	updateFooter();
}

/** Dynamic titlebar labels (language-dependent; refreshed on snapshot AND on language switch). */
function updateTitlebarLabels(snap) {
	if (!snap) return;
	$("#tb-model").textContent = snap.model ? `${snap.model.provider}/${snap.model.id}` : t("app.noModel");
	$("#tb-thinking").textContent = snap.thinkingLevel ? t("app.thinkPrefix", { level: snap.thinkingLevel }) : "";
	$("#tb-session").textContent = snap.sessionName ?? t("info.unnamed");
	$("#tb-cwd").textContent = snap.cwd ?? "";
}

function applySnapshot(snap, { quiet = false } = {}) {
	state.snapshot = snap;
	applyTheme(snap.settings?.theme);
	document.title = snap.sessionName ? `π ${snap.sessionName}` : state.appVersion ? `Pi Desktop ${state.appVersion}` : "Pi Desktop";

	// titlebar
	updateThemeButton();
	updateTitlebarLabels(snap);

	// editor completions
	editor.setCommands(
		BUILTIN_COMMANDS,
		(snap.resources?.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
		snap.resources?.prompts ?? [],
		snap.extensionCommands ?? [],
	);

	transcript.setMessages(snap.messages);
	updateStatus();
	updateFooter();

	if (!quiet) {
		if (snap.diagnostics?.length) {
			for (const d of snap.diagnostics) {
				if (d.type === "error") toast(d.message, "error", 8000);
				else if (d.type === "warning") state.warning = d.message;
			}
		}
		if (snap.modelFallbackMessage) {
			toast(snap.modelFallbackMessage, "warning", 8000);
		}
	} else {
		state.warning = undefined;
	}
}

// ---------------------------------------------------------------- footer/status

function updateFooter() {
	const snap = state.snapshot;
	if (!snap) return;
	const keysEl = $("#footer-keys");
	const b = state.bindings;
	const label = (action, fallback) => {
		const combos = b[action];
		if (!combos) return fallback;
		const list = Array.isArray(combos) ? combos : [combos];
		return list
			.map((c) => {
				const parts = c.toLowerCase().split("+");
				const key = parts.pop();
				const mods = parts.map((p) => (p === "ctrl" ? "Ctrl" : p === "alt" ? "Alt" : p === "meta" ? (navigator.platform.includes("Win") ? "Ctrl" : "⌘") : p[0].toUpperCase() + p.slice(1)));
				const keyNames = { enter: "↵", escape: "Esc", tab: "Tab", backspace: "⌫", up: "↑", down: "↓", pageup: "PgUp", pagedown: "PgDn", " ": "space" };
			const keyName = keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key);
				return `${mods.join("+")}${mods.length ? "+" : ""}${keyName}`;
			})
			.join(" / ");
	};
	keysEl.innerHTML = [
		["app.input.submit", "Enter"],
		["app.interrupt", "Esc"],
		["app.model.cycleForward", "Ctrl+P"],
		["app.thinking.cycle", "Shift+Tab"],
		["app.tools.expand", "Ctrl+O"],
		["app.message.copy", "Ctrl+X"],
		["app.editor.screenshot", "Ctrl+Shift+S"],
	].map(([action, fallback]) => {
			const hint = {
				"app.input.submit": t("footer.submit"),
				"app.interrupt": t("footer.interrupt"),
				"app.model.cycleForward": t("footer.cycleForward"),
				"app.thinking.cycle": t("footer.cycle"),
				"app.tools.expand": t("footer.expand"),
				"app.message.copy": t("footer.copy"),
				"app.editor.screenshot": t("footer.screenshot"),
			}[action] ?? action.split(".").pop().replace(/([A-Z])/g, " $1").toLowerCase();
			return `<span class="key-hint"><b>${label(action, fallback)}</b> ${escapeText(hint)}</span>`;
		}).join("");

	const info = [];
	if (snap.model) info.push(`${snap.model.provider}/${snap.model.id}`);
	if (snap.thinkingLevel && snap.thinkingLevel !== "off") info.push(t("app.thinkShort", { level: snap.thinkingLevel }));
	const ctx = formatContextUsage(snap.contextUsage);
	if (ctx) info.push(ctx);
	const stats = snap.stats;
	if (stats?.totalCost != null) info.push(formatCost(stats.totalCost));
	if (snap.gitBranch) info.push(`⎇ ${snap.gitBranch}`);
	if (state.warning) info.push(`⚠ ${state.warning}`);
	$("#footer-info").textContent = info.join(" · ");
}

function updateStatus() {
	const snap = state.snapshot;
	const line = $("#status-line");
	const pending = $("#pending");
	if (!snap) return;

	// pending queue
	const queueItems = [
		...(snap.queue?.steering ?? []).map((text) => `<span class="queue-item">↪ ${escapeText(t("status.steer", { text }))}</span>`),
		...(snap.queue?.followUp ?? []).map((text) => `<span class="queue-item">… ${escapeText(t("status.followUp", { text }))}</span>`),
	];
	if (queueItems.length > 0) {
		pending.hidden = false;
		pending.innerHTML = queueItems.join("");
	} else {
		pending.hidden = true;
	}

	// status
	const parts = [];
	if (snap.isCompacting) {
		parts.push(`<span class="spinner"></span><span class="status-text">${escapeText(t("status.compacting"))}</span>`);
	} else if (snap.isStreaming || state.agentRunning) {
		// the spinner itself lives in the transcript, following the streaming
		// output; only an extension-provided working message is shown here
		if (state.workingVisible && state.workingMessage) {
			parts.push(`<span class="status-text">${escapeText(state.workingMessage)}</span>`);
		}
	} else if (snap.isRetrying) {
		parts.push(`<span class="spinner"></span><span class="status-text">${escapeText(t("status.retrying", { n: snap.retryAttempt }))}</span>`);
	} else if (snap.isBashRunning) {
		parts.push(`<span class="spinner"></span><span class="status-text">${escapeText(t("status.runningBash"))}</span>`);
	}
	if (state.extensionStatus.size > 0) {
		for (const [key, text] of state.extensionStatus) {
			if (text) parts.push(`<span class="status-text">[${escapeText(key)}] ${escapeText(text)}</span>`);
		}
	}
	if (parts.length > 0) {
		line.hidden = false;
		line.innerHTML = parts.join("");
	} else {
		line.hidden = true;
	}
}

function escapeText(s) {
	return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- events

function handleAgentEvent(event) {
	switch (event.type) {
		case "agent_start":
			state.agentRunning = true;
			// reset any extension working indicator left over from a previous run
			state.workingMessage = undefined;
			state.workingVisible = true;
			transcript.showWaiting();
			updateStatus();
			break;
		case "agent_end":
			state.agentRunning = false;
			// the settled snapshot can still report isStreaming (SDK lags behind
			// the settled event); clear it so the status line doesn't stick
			if (state.snapshot) state.snapshot.isStreaming = false;
			transcript.clearWaiting();
			// individual message_end events already committed each message;
			// agent_settled triggers a fresh snapshot rebuild
			updateStatus();
			updateFooter();
			break;
		case "agent_settled": {
			// Guard against a stale snapshot: the request may have been in flight
			// when a new prompt started, and applying it would drop the fresh
			// messages from the transcript. Retry briefly if the reply lags.
			const expected = transcript.messageCount;
			void refreshSnapshot(expected);
			break;
		}
		case "message_start":
			if (event.message?.role === "assistant") {
				transcript.startAssistantStream(event.message);
			}
			break;
		case "message_update":
			if (event.message?.role === "assistant") {
				transcript.handleMessageUpdate(event.message, event.assistantMessageEvent);
			}
			break;
		case "message_end":
			if (event.message?.role === "assistant") {
				transcript.commitAssistant(event.message);
			} else if (event.message && !transcript.hasCommitted(event.message)) {
				transcript.addMessage(event.message);
			}
			updateStatus();
			break;
		case "tool_execution_start":
			transcript.handleToolStart(event);
			break;
		case "tool_execution_update":
			transcript.handleToolUpdate(event);
			break;
		case "tool_execution_end":
			transcript.handleToolEnd(event);
			break;
		case "bash_execution_update":
			transcript.handleBashDelta(event.delta ?? "");
			break;
		case "queue_update":
			state.snapshot && (state.snapshot.queue = { steering: event.steering, followUp: event.followUp });
			updateStatus();
			break;
		case "entry_appended": {
			const entry = event.entry;
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				transcript.addSummary(entry.summary, entry.type === "compaction" ? "compactionSummary" : "branchSummary");
			}
			break;
		}
		case "session_info_changed":
			if (state.snapshot) state.snapshot.sessionName = event.name;
			$("#tb-session").textContent = event.name ?? t("info.unnamed");
			break;
		case "thinking_level_changed":
			if (state.snapshot) {
				state.snapshot.thinkingLevel = event.level;
				$("#tb-thinking").textContent = `think: ${event.level}`;
			}
			break;
		case "compaction_start":
			state.compacting = true;
			updateStatus();
			break;
		case "compaction_end":
			state.compacting = false;
			if (event.aborted) toast(t("app.compactionAborted"), "warning");
			else if (event.errorMessage) toast(t("app.compactionFailed", { error: event.errorMessage }), "error");
			else toast(t("app.compactionComplete"), "success");
			transcript.rebuild();
			updateStatus();
			updateFooter();
			break;
		case "auto_retry_start":
			toast(t("app.retrying", { attempt: event.attempt, error: event.errorMessage }), "warning");
			updateStatus();
			break;
		case "auto_retry_end":
			if (!event.success) toast(t("app.retryFailed", { error: event.finalError ?? "" }), "error");
			updateStatus();
			break;
		default:
			break;
	}
}

window.pi.on("agent:event", handleAgentEvent);

window.pi.on("host:ready", (snap) => {
	applySnapshot(snap);
	editor.focus();
});

window.pi.on("host:session-replaced", (snap) => {
	applySnapshot(snap);
	toast(t("app.sessionSwitched"), "info");
	editor.focus();
});

window.pi.on("host:notify", ({ message, type }) => {
	toast(message, type ?? "info", 6000);
});

window.pi.on("host:auth-changed", () => {
	window.pi.invoke("models.authStatus").then((s) => {
		state.lastAuthStatus = s;
	});
});

// ------------------------------------------------------- extension ui bridge

window.pi.on("ext.ui.request", async (req) => {
	try {
		let value;
		let cancelled = false;
		switch (req.kind) {
			case "select": {
				// options may be strings or {label, value} objects
				const opts = (req.options ?? []).map((o) =>
					typeof o === "object" && o !== null
						? { label: String(o.label ?? o.value ?? ""), value: o.value ?? o.label }
						: { label: String(o), value: o },
				);
				value = await new Promise((resolve) => {
					modals.openModalPublic({
						title: req.title,
						items: opts.map((o) => ({ label: o.label, data: o.value })),
						onSelect: (item) => {
							resolve(item.data);
							return false;
						},
						onClose: () => resolve(undefined),
					});
				});
				cancelled = value === undefined;
				break;
			}
			case "confirm":
				value = await modals.openConfirmDialog({ title: req.title, message: req.message ?? "" });
				cancelled = false;
				break;
			case "input":
				value = await modals.openInputDialog({ title: req.title, placeholder: req.placeholder });
				cancelled = value === undefined;
				break;
			case "editor":
				value = await modals.openInputDialog({ title: req.title, placeholder: "", initial: req.prefill ?? "" });
				cancelled = value === undefined;
				break;
		}
		window.pi.notifyUiResponse(req.id, value, cancelled);
	} catch (error) {
		window.pi.notifyUiResponse(req.id, undefined, true);
	}
});

window.pi.on("ext.widget", ({ key, lines, options }) => {
	const container = options?.placement === "below" ? $("#widgets-below") : $("#widgets-above");
	if (!lines) {
		container.hidden = true;
		container.textContent = "";
		return;
	}
	container.hidden = false;
	container.textContent = lines.join("\n");
});

window.pi.on("ext.status", ({ key, text }) => {
	if (text) state.extensionStatus.set(key, text);
	else state.extensionStatus.delete(key);
	updateStatus();
});

window.pi.on("ext.working", ({ message, visible, indicator }) => {
	if (message !== undefined) state.workingMessage = message;
	if (visible !== undefined) state.workingVisible = visible;
	if (indicator?.frames === []) state.workingVisible = false;
	updateStatus();
});

window.pi.on("ext.editor.setText", ({ text }) => {
	editor.setText(text);
	window.pi.invoke("ext.editor.cache", { text });
});

window.pi.on("ext.editor.paste", ({ text }) => {
	const current = editor.getText();
	editor.setText((current ? current + "\n" : "") + text);
	window.pi.invoke("ext.editor.cache", { text: editor.getText() });
	editor.focus();
});

// ---------------------------------------------------------------- auth flow

window.pi.on("auth.prompt", (req) => {
	const p = req.prompt;
	const show = (status, action) => {
		const root = $("#login-root");
		root.hidden = false;
		root.innerHTML = `
			<div class="login-card">
				<h3>Authentication</h3>
				<div class="login-status"></div>
				<div class="login-body"></div>
				<div class="login-actions"></div>
			</div>`;
		root.querySelector(".login-status").textContent = status ?? "";
		const body = root.querySelector(".login-body");
		const actions = root.querySelector(".login-actions");
		if (action) action(body, actions, root);
	};

	const finish = (value, cancelled) => {
		window.pi.respondAuth(req.id, value, cancelled);
		$("#login-root").hidden = true;
		$("#login-root").innerHTML = "";
	};

	if (p.type === "select") {
		show(p.message, (body, actions, root) => {
			for (const opt of p.options) {
				const btn = document.createElement("button");
				btn.className = "primary";
				btn.textContent = opt.label;
				btn.style.display = "block";
				btn.style.width = "100%";
				btn.style.marginBottom = "6px";
				btn.addEventListener("click", () => finish(opt.id));
				body.appendChild(btn);
			}
			const cancel = document.createElement("button");
			cancel.textContent = t("auth.cancel");
			cancel.addEventListener("click", () => finish(undefined, true));
			actions.appendChild(cancel);
		});
	} else {
		show(p.message, (body, actions, root) => {
			const input = document.createElement("input");
			input.type = p.type === "secret" ? "password" : "text";
			input.placeholder = p.placeholder ?? "";
			input.style.cssText = "width:100%;padding:7px 10px;font-size:calc(14px * var(--fs, 1.1429))";
			body.appendChild(input);
			input.focus();
			const ok = document.createElement("button");
			ok.className = "primary";
			ok.textContent = t("auth.submit");
			ok.addEventListener("click", () => finish(input.value));
			const cancel = document.createElement("button");
			cancel.textContent = t("auth.cancel");
			cancel.addEventListener("click", () => finish(undefined, true));
			actions.append(ok, cancel);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") finish(input.value);
			});
		});
	}
});

window.pi.on("auth.notify", ({ event }) => {
	const root = $("#login-root");
	if (root.hidden) {
		root.hidden = false;
		root.innerHTML = `<div class="login-card"><h3>${t("auth.title")}</h3><div class="login-status"></div><div class="login-actions"><button class="login-cancel">${t("auth.close")}</button></div></div>`;
		root.querySelector(".login-cancel").addEventListener("click", () => (root.hidden = true));
	}
	const status = root.querySelector(".login-status");
	if (!status) return;
	if (event.type === "auth_url") {
		status.textContent = t("app.authOpening", { instructions: event.instructions ?? t("app.authDefaultInstructions") });
	} else if (event.type === "device_code") {
		status.textContent = "";
		root.querySelector(".login-card").innerHTML += `<pre style="font-size:calc(20px * var(--fs, 1.1429));text-align:center;letter-spacing:0.1em">${escapeText(event.userCode)}</pre><p style="text-align:center">${escapeText(event.verificationUri)}</p>`;
	} else if (event.type === "info") {
		status.textContent = event.message ?? "";
	} else if (event.type === "progress") {
		status.textContent = event.message ?? "…";
	}
});

// ---------------------------------------------------------------- menu events

const menuHandlers = {
	"menu:open-folder": async () => {
		const dir = await window.pi.invoke("system.pickDirectory");
		if (dir) {
			const res = await window.pi.invoke("system.reconfigure", { cwd: dir });
			if (res?.error) toast(res.error, "error");
		}
	},
	"menu:open-session": async () => {
		const path = await window.pi.invoke("system.pickFile", {
			filters: [{ name: "pi sessions", extensions: ["jsonl"] }],
		});
		if (path) {
			const res = await invokeSafe("session.import", { path });
			if (res?.error) toast(res.error, "error");
		}
	},
	"menu:new-session": () => runCommand("/new"),
	"menu:resume": () => runCommand("/resume"),
	"menu:workspaces": () => openWorkspacePickerUI(),
	"menu:fork": () => runCommand("/fork"),
	"menu:tree": () => runCommand("/tree"),
	"menu:abort": () => invokeSafe("session.abort"),
	"menu:compact": () => runCommand("/compact"),
	"menu:model": () => runCommand("/model"),
	"menu:thinking": () => runCommand("/thinking"),
	"menu:theme": () => runCommand("/theme"),
	"menu:settings": () => runCommand("/settings"),
	"menu:export-html": () => runCommand("/export"),
	"menu:export-jsonl": async () => {
		const path = await window.pi.invoke("system.pickFile", {
			filters: [{ name: "jsonl", extensions: ["jsonl"] }],
		});
		if (path) {
			const result = await invokeSafe("session.exportJsonl", { path });
			if (result) toast(t("app.savedJsonl", { path: result }), "success");
		}
	},
	"menu:save-jsonl": async () => {
		const result = await invokeSafe("session.exportJsonl", {});
		if (result) toast(t("app.savedJsonl", { path: result }), "success");
	},
	"menu:hotkeys": () => runCommand("/hotkeys"),
	"menu:help": () => runCommand("/help"),
};

for (const [channel, handler] of Object.entries(menuHandlers)) {
	window.pi.on(channel, () => void handler());
}

// ---------------------------------------------------------------- helpers

async function invokeSafe(channel, params) {
	try {
		return await window.pi.invoke(channel, params);
	} catch (error) {
		toast(error.message, "error", 6000);
		return undefined;
	}
}

// ---------------------------------------------------------------- commands

/** Custom provider (global models.json) editor. Shared by /providers and Settings. */
async function openProvidersUI() {
	const cfg = (await invokeSafe("models.config.read", {})) ?? { path: "", providers: {} };
	if (cfg.error) toast(cfg.error, "warning");
	modals.openProviderConfig({
		path: cfg.path ?? "",
		providers: cfg.providers ?? {},
		onSave: async (providers) => {
			const res = await invokeSafe("models.config.save", { providers });
			if (res?.error) {
				toast(res.error, "error");
				return false;
			}
			toast(t("app.providersSaved", { path: res.path ?? cfg.path }), "success");
			return true;
		},
	});
}

async function runCommand(line) {
	const parsed = parseSlashCommand(line);
	if (!parsed) return false;
	const { name, args } = parsed;
	const snap = state.snapshot;
	switch (name) {
		case "/help":
			modals.openHelpModal({
				commands: BUILTIN_COMMANDS,
				skills: snap?.resources?.skills ?? [],
				extensions: snap?.extensionCommands ?? [],
			});
			return true;
		case "/new": {
			const res = await invokeSafe("session.new");
			if (res?.error) toast(res.error, "error");
			else toast(t("app.sessionStarted"), "info");
			return true;
		}
		case "/workspaces": {
			openWorkspacePickerUI();
			return true;
		}
		case "/resume": {
			const sessions = await invokeSafe("sessions.list", { all: true });
				if (sessions) {
					modals.openSessionSelector({
						sessions,
						all: true,
						cwd: snap?.cwd,
					onPick: async (s) => {
						if (s.isCurrent) {
							toast(t("app.alreadyInSession"), "info");
							return;
						}
						if (s.cwd && s.cwd !== (snap?.cwd ?? "")) {
							// cross-project: rebuild the runtime in that project's directory
							const res = await invokeSafe("system.reconfigure", { cwd: s.cwd, sessionPath: s.path });
							if (res?.error) toast(res.error, "error");
							return;
						}
						const res = await invokeSafe("session.resume", { path: s.path });
						if (res?.cancelled) toast(t("app.resumeCancelled"), "warning");
					},
					onRename: async (s, newName) => {
						// rename only applies to current session in pi
						if (s.isCurrent) {
							await invokeSafe("session.name.set", { name: newName });
						} else {
							toast(t("app.renameOnlyCurrent"), "warning");
						}
					},
					onDelete: async (s) => {
						if (s.isCurrent) {
							toast(t("app.cannotDeleteCurrent"), "warning");
							return;
						}
						await invokeSafe("sessions.delete", { path: s.path });
						toast(t("app.sessionDeleted"), "success");
					},
				});
			}
			return true;
		}
		case "/model":
			if (!snap) return true;
			if (args) {
				// direct: /model provider/id[:thinking]
				const match = args.match(/^([\w.-]+)\/([\w.-]+)(?::(\w+))?$/);
				if (match) {
					const res = await invokeSafe("session.model.set", { provider: match[1], id: match[2] });
					if (res?.error) toast(res.error, "error");
					else {
						setModelInUi(res.model ?? { provider: match[1], id: match[2] });
						toast(t("app.modelSet", { model: `${match[1]}/${match[2]}` }), "success");
					}
					return true;
				}
			}
			modals.openModelSelector({
				models: snap.models,
				current: snap.model,
				thinkingLevels: snap.thinkingLevels,
				platform: navigator.platform,
				onPick: async (m) => {
					const res = await invokeSafe("session.model.set", { provider: m.provider, id: m.id });
					if (res?.error) toast(res.error, "error");
					else {
						setModelInUi(res.model ?? { provider: m.provider, id: m.id });
						toast(t("app.modelSet", { model: `${m.provider}/${m.id}` }), "success");
					}
				},
			});
			return true;
		case "/thinking":
			if (args) {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
				if (levels.includes(args)) {
					const res = await invokeSafe("session.thinking.set", { level: args });
					if (res?.level) toast(t("app.thinkingSet", { level: res.level }), "success");
				} else {
					toast(t("app.unknownLevel", { level: args }), "warning");
				}
				return true;
			}
			modals.openThinkingSelector({
				levels: snap?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high"],
				current: snap?.thinkingLevel,
				onPick: (level) => invokeSafe("session.thinking.set", { level }),
			});
			return true;
		case "/theme": {
			const pickTheme = async (theme) => {
				const res = await invokeSafe("settings.set", { key: "theme", value: theme });
				if (res?.error) return toast(res.error, "error");
				applyTheme(theme);
				toast(t("app.themeSet", { theme }), "success");
			};
			if (args) {
				// "/theme <name>" or "/theme light/dark"
				const res = await invokeSafe("theme.list", {});
				const names = (res ?? []).map((t) => t.name);
				if (names.includes(args) || args.includes("/")) {
					await pickTheme(args);
				} else {
					toast(t("app.unknownTheme", { theme: args, list: names.join(", ") }), "warning");
				}
				return true;
			}
			const list = (await invokeSafe("theme.list", {})) ?? [];
			modals.openThemeSelector({
				themes: list,
				current: snap?.settings?.theme ?? "light",
				onPick: (theme) => void pickTheme(theme),
			});
			return true;
		}
		case "/settings": {
			const appInfo = (await invokeSafe("system.appInfo", {})) ?? {};
			if (appInfo.appVersion) state.appVersion = appInfo.appVersion;
			modals.openSettings({
				settings: snap?.settings ?? {},
				tools: snap?.tools ?? [],
				activeTools: snap?.activeTools ?? [],
				themeOptionsList: (await invokeSafe("theme.list", {})) ?? [],
				language: getLanguage(),
				onChange: async (key, value) => {
					const res = await invokeSafe("settings.set", { key, value });
					if (res?.error) toast(res.error, "error");
					if (key === "theme") applyTheme(value);
				},
				onToolsChange: async (names) => {
					await invokeSafe("session.tools.set", { names });
				},
				onLanguageChange: (lang) => void changeLanguage(lang),
				appVersion: appInfo.appVersion,
				onEditProviders: () => void openProvidersUI(),
			});
			return true;
		}
		case "/export": {
			const targetPath = args
				? args
				: await invokeSafe("system.pickFile", { filters: [{ name: "HTML", extensions: ["html"] }] });
			const result = await invokeSafe("session.exportHtml", { path: targetPath ?? undefined });
			if (result) {
				toast(t("app.exportedHtml", { path: result }), "success");
				await invokeSafe("system.revealPath", { path: result });
			}
			return true;
		}
		case "/import": {
			if (!args) {
				const path = await window.pi.invoke("system.pickFile", {
					filters: [{ name: "pi sessions", extensions: ["jsonl"] }],
				});
				if (path) {
					const res = await invokeSafe("session.import", { path });
					if (res?.error) toast(res.error, "error");
				}
			} else {
				const res = await invokeSafe("session.import", { path: args });
				if (res?.error) toast(res.error, "error");
			}
			return true;
		}
		case "/share": {
			const result = await invokeSafe("session.exportHtml", {});
			if (result) {
				toast(t("app.exportedSession", { path: result }), "success");
				await invokeSafe("system.revealPath", { path: result });
			}
			return true;
		}
		case "/copy": {
			const text = await invokeSafe("session.lastAssistantText");
			if (text) {
				await invokeSafe("system.clipboard.write", { text });
				toast(t("app.copiedLastMessage"), "success");
			} else {
				toast(t("app.noAssistantMessage"), "warning");
			}
			return true;
		}
		case "/name": {
			const name = await modals.openInputDialog({
				title: t("app.sessionNameTitle"),
				initial: snap?.sessionName ?? "",
				placeholder: args,
			});
			if (name !== undefined) {
				await invokeSafe("session.name.set", { name });
			}
			return true;
		}
		case "/session":
			modals.openSessionInfoModal({ info: { ...snap, stats: snap?.stats } });
			return true;
		case "/changelog": {
			const text = await invokeSafe("resources.changelog");
			modals.openChangelogModal({ text });
			return true;
		}
		case "/hotkeys":
			modals.openHotkeysModal({ bindings: state.bindings, platform: navigator.platform.includes("Win") ? "win32" : "darwin" });
			return true;
		case "/fork":
			await doFork();
			return true;
		case "/clone":
			await doFork(true);
			return true;
		case "/tree":
			await openTree();
			return true;
		case "/trust": {
			const res = await invokeSafe("trust.get");
			modals.openTrustModal({
				trusted: res?.trusted,
				onToggle: async (trusted) => {
					await invokeSafe("trust.set", { trusted });
					toast(trusted ? t("app.projectTrusted") : t("app.projectUntrusted"), "info");
				},
			});
			return true;
		}
		case "/login": {
			const status = await invokeSafe("models.authStatus");
			modals.openLoginSelector({
				providers: snap?.providers ?? [],
				authStatus: status,
				onLogin: async (providerId, method) => {
					const res = await invokeSafe("models.login", { providerId, method });
					if (res?.error) toast(res.error, "error");
					else toast(t("app.loggedIn", { provider: providerId }), "success");
				},
				onApiKey: async (providerId, key) => {
					const res = await invokeSafe("models.apiKey.set", { providerId, key });
					if (res?.error) toast(res.error, "error");
					else toast(t("app.apiKeySet", { provider: providerId }), "success");
				},
				onLogout: async (providerId) => {
					await invokeSafe("models.logout", { providerId });
				},
			});
			return true;
		}
		case "/logout": {
			const status = await invokeSafe("models.authStatus");
			const providers = (snap?.providers ?? []).map((p) => ({ label: p.name, data: p.id }));
			modals.openModalPublic({
				title: t("app.logoutProvider"),
				items: providers,
				onSelect: async (item) => {
					await invokeSafe("models.logout", { providerId: item.data });
					toast(t("app.loggedOut", { provider: item.data }), "success");
					return false;
				},
			});
			return true;
		}
		case "/compact": {
			if (args) {
				const res = await invokeSafe("session.compact", { instructions: args });
				if (res?.error) toast(res.error, "error");
			} else {
				const instructions = await modals.openInputDialog({
					title: t("app.compactTitle"),
					placeholder: t("app.compactPlaceholder"),
				});
				if (instructions !== undefined) {
					const res = await invokeSafe("session.compact", { instructions: instructions || undefined });
					if (res?.error) toast(res.error, "error");
				}
			}
			return true;
		}
		case "/reload": {
			const res = await invokeSafe("session.reload");
			toast(res?.error ?? t("app.reloadDone"), res?.error ? "error" : "success");
			return true;
		}
		case "/debug": {
			const resources = await invokeSafe("resources.get");
			modals.openDebugModal({
				systemPrompt: snap?.systemPrompt,
				resources,
				diagnostics: snap?.diagnostics,
				stats: snap?.stats,
			});
			return true;
		}
		case "/providers": {
			await openProvidersUI();
			return true;
		}
		case "/scoped-models": {
			if (args) {
				const res = await invokeSafe("session.scope.set", { patterns: args.split(/\s+/) });
				if (res?.diagnostics?.length) toast(res.diagnostics.join("\n"), "warning");
				toast(t("app.scopedModels", { n: res?.models?.length ?? 0 }), "info");
				return true;
			}
			const allModels = await invokeSafe("models.list", {});
			if (!allModels) return true;
			modals.openScopedModelsSelector({
				models: allModels,
				current: snap?.scopedModels ?? [],
				onSave: async (patterns) => {
					const res = await invokeSafe("session.scope.set", { patterns });
					if (res?.diagnostics?.length) toast(res.diagnostics.join("\n"), "warning");
					toast(t("app.scopedModels", { n: res?.models?.length ?? 0 }), "info");
				},
			});
			return true;
		}
		case "/arminsayshi":
			modals.openEasterEgg({ kind: "armin" });
			return true;
		case "/dementedelves":
			modals.openEasterEgg({ kind: "elves" });
			return true;
		case "/quit":
			window.close();
			return true;
		default: {
			// extension command / prompt template → send to session
			return false;
		}
	}
}

async function doFork(clone = false) {
	const snap = state.snapshot;
	const userMessages = await invokeSafe("session.forkMessages");
	if (!userMessages || userMessages.length === 0) {
		toast(t("app.noForkMessages"), "warning");
		return;
	}
	modals.openForkSelector({
		userMessages,
		onFork: async (entryId, position) => {
			const res = await invokeSafe("session.fork", { entryId, position });
			if (res?.selectedText && !editor.getText().trim()) {
				editor.setText(res.selectedText);
			}
		},
		onClone: async (entryId) => {
			const res = await invokeSafe("session.fork", { entryId, position: "at" });
			if (res?.selectedText && !editor.getText().trim()) {
				editor.setText(res.selectedText);
			}
		},
	});
}

async function openTree() {
	const tree = await invokeSafe("sessions.tree");
	if (!tree) return;
	modals.openTreeSelector({
		tree,
		filter: state.snapshot?.settings?.treeFilterMode ?? "default",
		onNavigate: async (row) => {
			const res = await invokeSafe("session.navigateTree", {
				targetId: row.id,
			});
			if (res?.cancelled) toast(t("app.navCancelled"), "warning");
		},
		onFork: async (row) => {
			await invokeSafe("session.fork", { entryId: row.id, position: "before" });
		},
		onClone: async (row) => {
			await invokeSafe("session.fork", { entryId: row.id, position: "at" });
		},
		onLabel: async (row, label) => {
			await invokeSafe("sessions.setLabel", { entryId: row.id, label: label || undefined });
		},
	});
}

// ---------------------------------------------------------------- editor wiring

const editor = new Editor({
	el: $("#editor"),
	attachTray: $("#attach-tray"),
	autocomplete: $("#autocomplete"),
	onSubmit: (text, images) => {
		if (parseSlashCommand(text)) {
			void runCommand(text).then((handled) => {
				if (!handled) void sendToSession(text, images);
			});
			return;
		}
		void sendToSession(text, images);
	},
	onFollowUp: (text, images) => {
		void window.pi.invoke("session.followUp", { text, images: images.length ? images : undefined }).catch((e) => toast(e.message, "error"));
		toast(t("app.queuedFollowUp"), "info", 1500);
	},
	onBash: (command, excluded) => {
		void (async () => {
			try {
				if (state.snapshot?.isBashRunning) {
					toast(t("app.bashAlreadyRunning"), "warning");
					return;
				}
				transcript.setBashExcluded(excluded);
				const result = await window.pi.invoke("session.bash.run", { command, excludeFromContext: excluded });
				if (result?.cancelled) toast(t("app.bashCancelled"), "warning");
				// No bash-end event from the SDK: pull the snapshot to replace the
				// live block with the finalized message (and refresh isBashRunning).
				try {
					applySnapshot(await window.pi.invoke("host.snapshot"), { quiet: true });
				} catch {
					/* snapshot pull is best-effort */
				}
			} catch (e) {
				toast(e.message, "error");
			}
		})();
	},
});

async function sendToSession(text, images) {
	const snap = state.snapshot;
	try {
		if (snap?.isStreaming || state.agentRunning) {
			// queue as steering while streaming (TUI behavior for plain Enter)
			await window.pi.invoke("session.prompt", { text, images, streamingBehavior: "steer" });
			toast(t("app.queuedSteering"), "info", 1500);
		} else {
			await window.pi.invoke("session.prompt", { text, images });
		}
	} catch (e) {
		toast(e.message, "error", 8000);
	}
}

// ---------------------------------------------------------------- screenshot

/**
 * Screen-region capture: the main process hides the app window, captures all
 * displays, and opens a fullscreen overlay where the user drags a rectangle.
 * The crop comes back as a "screenshot:preview" push, shown in a preview
 * modal (attach / retake / cancel).
 */
async function doScreenshot() {
	try {
		const res = await window.pi.invoke("system.screenshot.start");
		if (res?.error) toast(res.error, "warning");
	} catch (e) {
		toast(e.message, "error", 8000);
	}
}

/** Preview modal for a captured screen region (pushed from the main process). */
function showScreenshotPreview(shot) {
	openModalPublic({
		title: t("snap.previewTitle", { w: shot.width, h: shot.height }),
		width: "wide",
		renderBody: (body, { close }) => {
			body.innerHTML = `
				<div class="snap-preview"><img src="data:${shot.mime};base64,${shot.data}" alt="${escapeText(t("snap.alt"))}" /></div>
				<div class="snap-actions">
					<button class="snap-btn snap-attach">${escapeText(t("snap.attach"))}</button>
					<button class="snap-btn snap-retake">${escapeText(t("snap.retake"))}</button>
					<button class="snap-btn snap-cancel">${escapeText(t("snap.cancel"))}</button>
				</div>`;
			const attach = () => {
				const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				editor.attachImage({ name: `screenshot-${stamp}.png`, mime: shot.mime, data: shot.data });
				toast(t("snap.attached"), "success", 2500);
				close();
				editor.focus();
			};
			body.querySelector(".snap-attach").addEventListener("click", attach);
			body.querySelector(".snap-retake").addEventListener("click", () => {
				close();
				void doScreenshot();
			});
			body.querySelector(".snap-cancel").addEventListener("click", close);
			body._attach = attach;
		},
		onKey: (e) => {
			if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				document.querySelector("#modal-root .snap-attach")?.click();
				return true;
			}
		},
		footer: t("snap.footer"),
	});
}

window.pi.on("screenshot:preview", (shot) => {
	if (shot?.data) showScreenshotPreview(shot);
});

// ---------------------------------------------------------------- global keys

let lastEscapeTime = 0;

// Actions the editor/textarea must handle natively; intercepting them in the
// window handler would swallow the default action (e.g. Shift+Enter newline)
// without anything replacing it.
const EDITOR_LOCAL_ACTIONS = new Set([
	"app.input.submit",
	"app.input.newLine",
	"app.input.tab",
	"app.history.previous",
	"app.history.next",
]);

window.addEventListener("keydown", (e) => {
	const inModal = !modalsRootHidden();
	const editorEl = document.getElementById("editor");
	const inEditor = document.activeElement === editorEl;
	const combo = eventToCombo(e);
	const comboKey = [...combo.mods, combo.key].join("+").toLowerCase() || combo.key.toLowerCase();

	// modal open: let modals handle; but Esc is handled in modals
	if (inModal) return;

	// don't hijack global combos while the user is typing in a non-editor
	// text input (the transcript search bar handles its own keys — without
	// this, Esc-to-close would also fire app.interrupt and abort the session)
	const ae = document.activeElement;
	if (
		ae &&
		ae !== editorEl &&
		(ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
	) {
		return;
	}

	const action = state.comboIndex?.get(comboKey);
	if (action) {
		if (inEditor && EDITOR_LOCAL_ACTIONS.has(action)) return;
		// don't eat copy/cut when the user has a text selection (transcript or
		// editor); those combos map to app.clear / app.message.copy
		const sel = window.getSelection();
		if ((action === "app.clear" || action === "app.message.copy") && sel && !sel.isCollapsed) return;
		if (action === "app.clear" && inEditor && editorEl.selectionStart !== editorEl.selectionEnd) return;
		e.preventDefault();
		void performAction(action, e);
		return;
	}

	// double escape
	if (e.key === "Escape" && !inEditor) {
		const now = Date.now();
		if (now - lastEscapeTime < 400) {
			const mode = state.snapshot?.settings?.doubleEscapeAction ?? "fork";
			if (mode === "fork") void doFork();
			if (mode === "tree") void openTree();
		}
		lastEscapeTime = now;
	}
});

function modalsRootHidden() {
	return $("#modal-root").hidden;
}

async function performAction(action, e) {
	switch (action) {
		case "app.interrupt":
			void invokeSafe("session.abort");
			break;
		case "app.clear":
			editor.clear();
			break;
		case "app.exit":
			if (editor.getText().trim() === "") window.close();
			break;
		case "app.model.select":
			runCommand("/model");
			break;
		case "app.model.cycleForward":
			void invokeSafe("session.model.cycle", { backward: false }).then((res) => setModelInUi(res?.model, res?.thinkingLevel));
			break;
		case "app.model.cycleBackward":
			void invokeSafe("session.model.cycle", { backward: true }).then((res) => setModelInUi(res?.model, res?.thinkingLevel));
			break;
		case "app.thinking.cycle":
			void invokeSafe("session.thinking.cycle").then((res) => {
				if (res?.level) toast(t("app.thinkingSet", { level: res.level }), "info", 1200);
			});
			break;
		case "app.thinking.toggle":
			transcript.toggleThinkingCollapsed();
			break;
		case "app.tools.expand":
			transcript.toggleAllTools(!transcript.expandedAll);
			break;
		case "app.message.copy":
			runCommand("/copy");
			break;
		case "app.message.followUp":
			break; // handled in editor
		case "app.message.dequeue": {
			const cleared = await invokeSafe("session.queue.clear");
			if (cleared) {
				const all = [...cleared.steering, ...cleared.followUp];
				if (all.length > 0) editor.setText(all.join("\n"));
			}
			break;
		}
		case "app.editor.external":
			runCommand("/settings");
			break;
		case "app.clipboard.pasteImage":
			void editor.pasteClipboardImage();
			break;
		case "app.editor.screenshot":
			void doScreenshot();
			break;
		case "app.session.new":
			runCommand("/new");
			break;
		case "app.session.tree":
			openTree();
			break;
		case "app.session.fork":
			doFork();
			break;
		case "app.session.resume":
			runCommand("/resume");
			break;
		case "app.session.rename":
			runCommand("/name");
			break;
		case "app.session.delete":
			toast(t("app.deleteViaResume"), "info");
			break;
		case "app.transcript.search":
			toggleSearch();
			break;
		case "app.transcript.top":
			transcript.scrollToStart();
			break;
		case "app.transcript.bottom":
			transcript.scrollToEnd();
			break;
		case "app.transcript.previousPrompt":
			transcript.jumpToUserMessage(-1);
			break;
		case "app.transcript.nextPrompt":
			transcript.jumpToUserMessage(1);
			break;
		case "app.history.previous":
		case "app.history.next":
			// handled in editor
			break;
		default:
			break;
	}
}

// ---------------------------------------------------------------- search

let searchMatches = [];
let searchCurrent = 0;

function toggleSearch() {
	let bar = document.querySelector(".search-bar");
	if (bar) {
		bar.remove();
		clearSearchMarks();
		return;
	}
	clearSearchMarks();
	bar = document.createElement("div");
	bar.className = "search-bar";
	bar.innerHTML = `<input placeholder="${escapeText(t("search.placeholder"))}" /><span class="match-count"></span>`;
	document.body.appendChild(bar);
	const input = bar.querySelector("input");
	input.focus();
	let debounce;
	const run = (text) => {
		clearSearchMarks();
		searchMatches = [];
		if (!text) return;
		const walker = document.createTreeWalker(transcriptEl, NodeFilter.SHOW_TEXT);
		const nodes = [];
		while (walker.nextNode()) nodes.push(walker.currentNode);
		const lower = text.toLowerCase();
		for (const node of nodes) {
			let idx = node.textContent.toLowerCase().indexOf(lower);
			while (idx !== -1) {
				const range = document.createRange();
				range.setStart(node, idx);
				range.setEnd(node, idx + text.length);
				const mark = document.createElement("mark");
				mark.className = "search-hit";
				try {
					range.surroundContents(mark);
					searchMatches.push(mark);
				} catch {
					// node split; skip
				}
				idx = node.textContent.toLowerCase().indexOf(lower, idx + text.length);
			}
		}
		searchCurrent = 0;
		updateMatchCount();
		if (searchMatches.length > 0) {
			searchMatches[0].classList.add("current");
			searchMatches[0].scrollIntoView({ block: "center" });
		}
	};
	function updateMatchCount() {
		bar.querySelector(".match-count").textContent = searchMatches.length
			? `${searchCurrent + 1}/${searchMatches.length}`
			: "";
	}
	input.addEventListener("input", () => {
		clearTimeout(debounce);
		debounce = setTimeout(() => run(input.value.trim()), 250);
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (searchMatches.length === 0) return;
			searchMatches[searchCurrent]?.classList.remove("current");
			searchCurrent = (searchCurrent + (e.shiftKey ? -1 : 1) + searchMatches.length) % searchMatches.length;
			searchMatches[searchCurrent].classList.add("current");
			searchMatches[searchCurrent].scrollIntoView({ block: "center" });
			updateMatchCount();
		}
		if (e.key === "Escape") {
			bar.remove();
			clearSearchMarks();
		}
	});
}

function clearSearchMarks() {
	for (const mark of document.querySelectorAll("mark.search-hit")) {
		const parent = mark.parentNode;
		parent.replaceChild(document.createTextNode(mark.textContent), mark);
		parent.normalize();
	}
	searchMatches = [];
	searchCurrent = 0;
}

// ---------------------------------------------------------------- snapshot refresh

async function refreshSnapshot(expectedCount, attempt = 0) {
	let fresh;
	try {
		fresh = await window.pi.invoke("host.snapshot");
	} catch {
		return;
	}
	if (!fresh) return;
	if (expectedCount != null && (fresh.messages?.length ?? 0) < expectedCount && attempt < 5) {
		// stale reply (requested before a new prompt was appended) — retry
		await new Promise((r) => setTimeout(r, 150));
		await refreshSnapshot(expectedCount, attempt + 1);
		return;
	}
	// The settled refresh can race the SDK: the snapshot may still report
	// isStreaming although the agent events already marked the run finished.
	if (expectedCount != null && !state.agentRunning) fresh.isStreaming = false;
	applySnapshot(fresh, { quiet: true });
}

// ---------------------------------------------------------------- init

async function init() {
	const platform = window.pi.platform === "win32" ? "win32" : "darwin";
	const bindings = defaultBindings(platform);
	state.bindings = bindings;
	state.comboIndex = buildComboIndex(bindings);

	// i18n: apply the saved (or locale-detected) language before first render,
	// then tell the main process so the native menu matches.
	setLanguage(initialLanguage());
	applyI18n();
	window.pi.invoke("i18n.setLanguage", { language: getLanguage() }).catch(() => {});
	// app version (package.json), used in the window title and settings "About"
	const appInfo = (await window.pi.invoke("system.appInfo").catch(() => null)) ?? {};
	if (appInfo.appVersion) state.appVersion = appInfo.appVersion;

	// titlebar buttons
	$("#tb-new").addEventListener("click", () => runCommand("/new"));
	$("#tb-resume").addEventListener("click", () => runCommand("/resume"));
	$("#tb-tree").addEventListener("click", () => openTree());
	$("#tb-model-btn").addEventListener("click", () => runCommand("/model"));
	$("#tb-settings").addEventListener("click", () => runCommand("/settings"));
	$("#tb-theme").addEventListener("click", async () => {
		const target = currentAppearance() === "light" ? "dark" : "light";
		const res = await invokeSafe("settings.set", { key: "theme", value: target });
		if (res?.error) return toast(res.error, "error");
		await applyTheme(target);
		updateThemeButton();
	});
	$("#tb-font-down").addEventListener("click", () => setFontLevel(fontLevel() - 1));
	$("#tb-font-up").addEventListener("click", () => setFontLevel(fontLevel() + 1));
	setFontLevel(fontLevel());
	$("#tb-workspaces").addEventListener("click", () => openWorkspacePickerUI());
	$("#btn-screenshot").addEventListener("click", () => void doScreenshot());

	// cache editor text for extension getEditorText
	let lastCached = "";
	const cacheEditor = () => {
		const text = editor.getText();
		if (text !== lastCached) {
			lastCached = text;
			window.pi.invoke("ext.editor.cache", { text }).catch(() => {});
		}
	};
	document.getElementById("editor").addEventListener("input", cacheEditor);

	// poll state while streaming for status/footer freshness
	setInterval(() => {
		const snap = state.snapshot;
		if (snap && (snap.isStreaming || snap.isCompacting || snap.isBashRunning)) {
			// light refresh via lastAssistantText is heavy; just refresh footer info
			updateStatus();
		}
	}, 1000);

	// Pull the current snapshot. The one-shot host:ready push can be missed if
	// the renderer loads after main finished starting (common when the app is
	// packaged into asar and module loading is slower). host.snapshot is gated
	// on host readiness, so this resolves once the session is live.
	await refreshSnapshot(null);

	// First-run experience: when no workspace was chosen via CLI (--cwd /
	// --session) and this is not a smoke run, ask the user which workspace
	// to open (or to create a new one by picking a directory).
	const snap = state.snapshot;
	if (snap && !snap.explicitCwd && !snap.smoke) {
		openWorkspacePickerUI();
	}
}

void init();
