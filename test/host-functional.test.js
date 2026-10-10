/**
 * Functional tests for AgentHost (src/main/host.js).
 *
 * Boots a REAL SDK runtime (ModelRuntime → services → AgentSessionRuntime)
 * inside a sandboxed agent directory (PI_CODING_AGENT_DIR = temp dir) and
 * drives every IPC channel through the same "pi:invoke" handler the Electron
 * main process registers, i.e. exactly the path the renderer uses:
 *
 *   renderer: window.pi.invoke(ch, p)  →  ipcMain "pi:invoke"  →  host.dispatch
 *
 * `electron` is mocked (no display / no real window); everything SDK-side is
 * real. Channels that need a live LLM round-trip (session.prompt,
 * session.compact), an interactive browser flow (models.login) or a real
 * display (system.screenshot.start) are intentionally not exercised here —
 * see test/smoke-host.mjs for the SDK-level smoke path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// electron mock (hoisted so vi.mock can reference the state)
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
	ipcHandlers: new Map(),
	sent: [], // [channel, payload] pushes to the fake renderer window
	win: null,
	languageChanges: [],
	displays: [
		{ id: 1, label: "Main", size: { width: 100, height: 50 }, scaleFactor: 1, bounds: { x: 0, y: 0 } },
		{ id: 2, label: "", size: { width: 80, height: 40 }, scaleFactor: 1, bounds: { x: 100, y: 0 } },
	],
	sources: [
		{
			thumbnail: {
				isEmpty: () => false,
				toDataURL: () => "data:image/png;base64,QUJD",
				getSize: () => ({ width: 120, height: 60 }),
			},
		},
		{
			thumbnail: {
				isEmpty: () => false,
				toDataURL: () => "data:image/png;base64,RklH",
				getSize: () => ({ width: 80, height: 40 }),
			},
		},
	],
	clipboardText: null,
	clipboardImageEmpty: true,
	openExternalCalls: [],
	openPathCalls: [],
	revealPathCalls: [],
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel, fn) => state.ipcHandlers.set(channel, fn),
		removeHandler: (channel) => state.ipcHandlers.delete(channel),
		on: () => {},
	},
	app: { getVersion: () => "0.0.0-functional" },
	dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
	clipboard: {
		writeText: (text) => {
			state.clipboardText = text;
		},
		readImage: () => ({
			isEmpty: () => state.clipboardImageEmpty,
			toPNG: () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
		}),
	},
	shell: {
		openExternal: async (url) => {
			state.openExternalCalls.push(url);
			return "";
		},
		openPath: async (p) => {
			state.openPathCalls.push(p);
			return "";
		},
		showItemInFolder: (p) => {
			state.revealPathCalls.push(p);
		},
	},
	nativeTheme: { shouldUseDarkColors: true },
	desktopCapturer: { getSources: async () => state.sources },
	screen: {
		getAllDisplays: () => state.displays,
		getPrimaryDisplay: () => state.displays[0],
	},
	BrowserWindow: class {
		// only used by the snip overlay flow (not exercised headless)
		constructor() {
			this.webContents = { send: () => {} };
		}
		setAlwaysOnTop() {}
		setMaximumSize() {}
		setBounds() {}
		async loadFile() {}
		show() {}
		hide() {}
		isDestroyed() {
			return true;
		}
		destroy() {}
	},
}));

import { AgentHost } from "../src/main/host.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-func-"));
const agentDir = path.join(tmp, "agent");
const cwd = path.join(tmp, "proj");
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# functional test project\n");
// completion fixtures
fs.writeFileSync(path.join(cwd, "zfunc-a.txt"), "a");
fs.writeFileSync(path.join(cwd, "zfunc-apple.txt"), "apple");
fs.mkdirSync(path.join(cwd, "zfunc-area"), { recursive: true });
fs.writeFileSync(path.join(cwd, "zfunc-area", "beta.txt"), "b");
fs.writeFileSync(path.join(cwd, ".zfunc-secret"), "hidden");
fs.mkdirSync(path.join(cwd, "node_modules", "zfunc-pkg"), { recursive: true });
fs.writeFileSync(path.join(cwd, "node_modules", "zfunc-pkg", "zfunc-lib.txt"), "nm");
// image fixtures
const PNG_1x1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const pngPath = path.join(tmp, "pixel.png");
fs.writeFileSync(pngPath, PNG_1x1);
const txtPath = path.join(tmp, "not-image.txt");
fs.writeFileSync(txtPath, "nope");
const bigPath = path.join(tmp, "big.png");
fs.writeFileSync(bigPath, Buffer.alloc(11 * 1024 * 1024));

/** mirrors sessionDirForCwd() in host.js */
const sessionDirForCwd = (c) =>
	path.join(agentDir, "sessions", `--${path.resolve(c).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

// hand-crafted importable session (header + user + assistant message)
const importedJsonl = path.join(tmp, "imported.jsonl");
const ts = new Date().toISOString();
fs.writeFileSync(
	importedJsonl,
	[
		JSON.stringify({ type: "session", version: 3, id: "func-import-session", timestamp: ts, cwd }),
		JSON.stringify({ type: "thinking_level_change", id: "e1", parentId: null, timestamp: ts, thinkingLevel: "off" }),
		JSON.stringify({
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: ts,
			message: { role: "user", content: [{ type: "text", text: "hello import" }], timestamp: Date.now() },
		}),
		JSON.stringify({
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: ts,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
				api: "openai-completions",
				provider: "anthropic",
				model: "claude-func-test",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			},
		}),
	].join("\n") + "\n",
);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
let host;
const BOOT_TIMEOUT = 240_000;
const T = 60_000;

beforeAll(async () => {
	// sandbox every SDK-written file (settings.json, sessions/, themes/, …)
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SKIP_VERSION_CHECK = "1";

	state.win = {
		isDestroyed: () => false,
		isVisible: () => true,
		isMinimized: () => false,
		hide: () => {},
		show: () => {},
		focus: () => {},
		setTitle: () => {},
		webContents: { send: (channel, payload) => state.sent.push([channel, payload]) },
	};
	host = new AgentHost(() => state.win, (lang) => state.languageChanges.push(lang));
	await host.start({ cwd, explicitCwd: true });
}, BOOT_TIMEOUT);

afterAll(async () => {
	try {
		await host?.shutdown();
	} catch {
		// already shut down
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

// invoke through the REAL registered ipcMain handler (the renderer's path)
const invoke = (channel, params = {}) => state.ipcHandlers.get("pi:invoke")(null, channel, params);
const ok = async (channel, params) => {
	const env = await invoke(channel, params);
	expect(env, `envelope for ${channel}`).toBeTypeOf("object");
	expect(env.ok, `channel ${channel} failed: ${env.error}`).toBe(true);
	return env.result;
};
const err = async (channel, params) => {
	const env = await invoke(channel, params);
	expect(env.ok, `channel ${channel} unexpectedly succeeded: ${JSON.stringify(env.result)?.slice(0, 200)}`).toBe(false);
	return String(env.error ?? "");
};
const pushed = (channel) => state.sent.filter(([c]) => c === channel);

// ---------------------------------------------------------------------------

describe("boot & snapshot", () => {
	it("pushes host:ready with a full snapshot", () => {
		const ready = pushed("host:ready");
		expect(ready.length).toBeGreaterThanOrEqual(1);
		const snap = ready[0][1];
		expect(snap.cwd).toBe(path.resolve(cwd));
		expect(snap.agentDir).toBe(agentDir);
		expect(snap.platform).toBe(process.platform);
		expect(typeof snap.shell).toBe("string");
		expect(snap.explicitCwd).toBe(true);
		expect(snap.smoke).toBe(false);
		expect(typeof snap.sessionId).toBe("string");
		expect(Array.isArray(snap.messages)).toBe(true);
		expect(snap.activeTools).toEqual(expect.arrayContaining(["read", "edit", "write"]));
		expect(snap.tools.length).toBeGreaterThanOrEqual(4);
		expect(Array.isArray(snap.scopedModels)).toBe(true);
		expect(Array.isArray(snap.queue.steering)).toBe(true);
		expect(Array.isArray(snap.queue.followUp)).toBe(true);
		expect(Array.isArray(snap.models)).toBe(true);
		expect(snap.models.length).toBeGreaterThan(0);
		expect(Array.isArray(snap.providers)).toBe(true);
		expect(snap.providers.length).toBeGreaterThan(0);
		// a fresh agent dir has no theme configured yet
		expect(snap.settings.theme === undefined || typeof snap.settings.theme === "string").toBe(true);
		expect(Array.isArray(snap.themes)).toBe(true);
		expect(snap.themes.length).toBeGreaterThan(0);
		expect(Array.isArray(snap.diagnostics)).toBe(true);
		expect(Array.isArray(snap.resources.extensions)).toBe(true);
		expect(Array.isArray(snap.resources.skills)).toBe(true);
	}, T);

	it("host.snapshot is pullable at any time", async () => {
		const snap = await ok("host.snapshot");
		expect(snap.sessionId).toBe(host.session.sessionId);
		expect(snap.systemPrompt.length).toBeGreaterThan(100);
	}, T);
});

describe("IPC envelope", () => {
	it("unknown channel → error envelope", async () => {
		const env = await invoke("no.such.channel");
		expect(env.ok).toBe(false);
		expect(env.error).toContain("Unknown channel");
	}, T);
});

describe("i18n", () => {
	it("setLanguage switches UI language and notifies", async () => {
		const r = await ok("i18n.setLanguage", { language: "zh" });
		expect(r).toEqual({ ok: true, language: "zh" });
		expect(state.languageChanges).toContain("zh");
		await ok("i18n.setLanguage", { language: "en" });
	}, T);
});

describe("system", () => {
	it("system.platform reports platform/shell/theme", async () => {
		const r = await ok("system.platform");
		expect(r.platform).toBe(process.platform);
		expect(typeof r.shell).toBe("string");
		expect(r.nativeTheme).toBe("dark");
	}, T);

	it("system.appInfo reports versions", async () => {
		const r = await ok("system.appInfo");
		expect(r.appVersion).toBe("0.0.0-functional");
		expect(r.node).toBe(process.version);
	}, T);

	it("native dialogs report cancellation as undefined", async () => {
		expect(await ok("system.pickDirectory")).toBeUndefined();
		expect(await ok("system.pickFile", { filters: [] })).toBeUndefined();
	}, T);

	it("system.readFileBase64 reads supported images", async () => {
		const r = await ok("system.readFileBase64", { path: pngPath });
		expect(r.mime).toBe("image/png");
		expect(Buffer.from(r.data, "base64").equals(PNG_1x1)).toBe(true);
	}, T);

	it("system.readFileBase64 rejects non-images", async () => {
		const e = await err("system.readFileBase64", { path: txtPath });
		expect(e.length).toBeGreaterThan(0);
	}, T);

	it("system.readFileBase64 rejects files over 10MB", async () => {
		const e = await err("system.readFileBase64", { path: bigPath });
		expect(e.length).toBeGreaterThan(0);
	}, T);

	it("system.fs.list completes prefixes (skips dotfiles/node_modules)", async () => {
		expect(await ok("system.fs.list", { prefix: "" })).toEqual([]);
		const hits = await ok("system.fs.list", { prefix: "zfunc-a" });
		expect(hits).toEqual(expect.arrayContaining(["/zfunc-a.txt", "/zfunc-apple.txt", "/zfunc-area"]));
		expect(hits.join("\n")).not.toContain(".zfunc-secret");
		expect(hits.join("\n")).not.toContain("node_modules");
		const nested = await ok("system.fs.list", { prefix: "zfunc-area/be" });
		expect(nested).toContain("/zfunc-area/beta.txt");
		expect(await ok("system.fs.list", { prefix: "z".repeat(600) })).toEqual([]);
	}, T);

	it("system.clipboard.write writes text", async () => {
		state.clipboardText = null;
		await ok("system.clipboard.write", { text: "hello-clip" });
		expect(state.clipboardText).toBe("hello-clip");
	}, T);

	it("system.clipboard.readImage → undefined without an image", async () => {
		state.clipboardImageEmpty = true;
		expect(await ok("system.clipboard.readImage")).toBeUndefined();
	}, T);

	it("system.displays maps the screen list", async () => {
		const r = await ok("system.displays");
		expect(r.map((d) => d.index)).toEqual([0, 1]);
		expect(r[0].name).toBe("Main");
		expect(r[0].isPrimary).toBe(true);
		expect(r[1].isPrimary).toBe(false);
		expect(r[0].width).toBe(100);
	}, T);

	it("system.screenshot returns display 0 and clamps index", async () => {
		const r0 = await ok("system.screenshot", { index: 0 });
		expect(r0).toMatchObject({ data: "QUJD", mime: "image/png", width: 120, height: 60 });
		const rClamped = await ok("system.screenshot", { index: 99 });
		expect(rClamped.data).toBe("RklH");
	}, T);

	it("system.openExternal only opens http(s)", async () => {
		state.openExternalCalls = [];
		await ok("system.openExternal", { url: "https://example.com" });
		expect(state.openExternalCalls).toEqual(["https://example.com"]);
		await ok("system.openExternal", { url: "file:///C:/x" });
		expect(state.openExternalCalls).toEqual(["https://example.com"]);
	}, T);

	it("system.openPath / revealPath act only on existing paths", async () => {
		const existing = path.join(tmp, "exists.txt");
		fs.writeFileSync(existing, "x");
		const missing = path.join(tmp, "missing.txt");
		state.openPathCalls = [];
		state.revealPathCalls = [];
		await ok("system.openPath", { path: existing });
		expect(state.openPathCalls).toEqual([existing]);
		await ok("system.openPath", { path: missing });
		expect(state.openPathCalls).toEqual([existing]);
		await ok("system.revealPath", { path: existing });
		expect(state.revealPathCalls).toEqual([existing]);
		await ok("system.revealPath", { path: missing });
		expect(state.revealPathCalls).toEqual([existing]);
	}, T);
});

describe("models / auth / thinking", () => {
	it("models.list returns the catalog", async () => {
		const models = await ok("models.list");
		expect(models.length).toBeGreaterThan(0);
		expect(models[0]).toHaveProperty("provider");
		expect(models[0]).toHaveProperty("id");
	}, T);

	it("models.authStatus reports provider statuses + credentials", async () => {
		const r = await ok("models.authStatus");
		expect(r.providers.length).toBeGreaterThan(0);
		expect(r.providers[0]).toHaveProperty("id");
		expect(Array.isArray(r.credentials)).toBe(true);
	}, T);

	it("models.apiKey.set/remove manage runtime credentials", async () => {
		await ok("models.apiKey.set", { providerId: "anthropic", key: "sk-func-test" });
		expect(pushed("host:auth-changed").length).toBeGreaterThanOrEqual(1);
		const status = await ok("models.authStatus");
		expect(status.providers.find((p) => p.id === "anthropic")?.status?.configured).toBe(true);
		await ok("models.apiKey.remove", { providerId: "anthropic" });
		const after = await ok("models.authStatus");
		expect(after.providers.find((p) => p.id === "anthropic")?.status?.configured).not.toBe(true);
	}, T);

	it("session.model.set selects a catalog model (with runtime key)", async () => {
		await ok("models.apiKey.set", { providerId: "anthropic", key: "sk-func-test" });
		const models = await ok("models.list");
		const target = models.find((m) => m.provider === "anthropic");
		expect(target, "catalog contains an anthropic model").toBeTruthy();
		const r = await ok("session.model.set", { provider: target.provider, id: target.id });
		expect(r.model).toEqual({ provider: target.provider, id: target.id });
		expect(host.session.model.id).toBe(target.id);
	}, T);

	it("session.model.set rejects unknown models", async () => {
		const e = await err("session.model.set", { provider: "nope", id: "nothing" });
		expect(e.length).toBeGreaterThan(0);
	}, T);

	it("session.model.cycle moves to the next model", async () => {
		const before = host.session.model.id;
		await ok("session.model.cycle", { backward: false });
		const after = host.session.model.id;
		expect(typeof after).toBe("string");
		if (await ok("models.list").length > 1) {
			expect(after).not.toBe(before);
		}
		await ok("session.model.cycle", { backward: true });
	}, T);

	it("session.thinking.set / cycle change the level", async () => {
		const r = await ok("session.thinking.set", { level: "low" });
		expect(r.level).toBe("low");
		const c = await ok("session.thinking.cycle");
		expect(typeof c.level).toBe("string");
		expect(c.level).not.toBe("low");
	}, T);

	it("session.scope.set resolves patterns and reports diagnostics", async () => {
		const match = await ok("session.scope.set", { patterns: ["anthropic/*sonnet*"] });
		expect(Array.isArray(match.models)).toBe(true);
		expect(match.models.every((m) => m.provider === "anthropic" && m.id.includes("sonnet"))).toBe(true);
		const bad = await ok("session.scope.set", { patterns: ["no-such-provider/*"] });
		expect(bad.diagnostics.length).toBeGreaterThan(0);
		// restore: no restriction
		const all = await ok("session.scope.set", { patterns: [] });
		expect(Array.isArray(all.models)).toBe(true);
	}, T);
});

describe("tools", () => {
	it("session.tools.list returns every tool", async () => {
		const tools = await ok("session.tools.list");
		const names = tools.map((t) => t.name);
		expect(names).toEqual(expect.arrayContaining(["read", "edit", "write"]));
		expect(names.some((n) => n === "bash" || n === "powershell")).toBe(true);
		expect(tools.every((t) => typeof t.description === "string")).toBe(true);
	}, T);

	it("session.tools.set activates exactly the requested set", async () => {
		const snapshot = await ok("host.snapshot");
		const original = [...snapshot.activeTools];
		const r = await ok("session.tools.set", { names: ["read", "grep"] });
		expect(r.active).toEqual(["read", "grep"]);
		expect(host.session.getActiveToolNames()).toEqual(["read", "grep"]);
		await ok("session.tools.set", { names: original });
		expect(host.session.getActiveToolNames()).toEqual(original);
	}, T);
});

describe("prompting queue (no LLM)", () => {
	it("session.steer / followUp queue messages", async () => {
		await ok("session.steer", { text: "steer-1" });
		await ok("session.followUp", { text: "followup-1" });
		const snap = await ok("host.snapshot");
		expect(snap.queue.steering.length).toBe(1);
		expect(snap.queue.followUp.length).toBe(1);
	}, T);

	it("session.queue.clear returns and empties the queues", async () => {
		const cleared = await ok("session.queue.clear");
		expect(JSON.stringify(cleared)).toContain("steer-1");
		expect(JSON.stringify(cleared)).toContain("followup-1");
		const snap = await ok("host.snapshot");
		expect(snap.queue.steering).toEqual([]);
		expect(snap.queue.followUp).toEqual([]);
	}, T);

	it("steering/followUp modes are settable", async () => {
		await ok("session.steeringMode", { mode: "one-at-a-time" });
		await ok("session.followUpMode", { mode: "one-at-a-time" });
		expect(host.session.steeringMode).toBe("one-at-a-time");
		expect(host.session.followUpMode).toBe("one-at-a-time");
	}, T);

	it("session.abort / waitForIdle are safe no-ops when idle", async () => {
		expect((await ok("session.abort")).ok).toBe(true);
		expect((await ok("session.waitForIdle")).ok).toBe(true);
	}, T);
});

describe("compaction / retry switches", () => {
	it("auto switches are persisted in the snapshot", async () => {
		await ok("session.compaction.setAuto", { enabled: true });
		await ok("session.retry.setAuto", { enabled: true });
		const snap = await ok("host.snapshot");
		expect(snap.autoCompaction).toBe(true);
		expect(snap.autoRetry).toBe(true);
		await ok("session.compaction.setAuto", { enabled: false });
		await ok("session.retry.setAuto", { enabled: false });
		const after = await ok("host.snapshot");
		expect(after.autoCompaction).toBe(false);
		expect(after.autoRetry).toBe(false);
	}, T);

	it("abort channels are safe no-ops", async () => {
		expect((await ok("session.compact.abort")).ok).toBe(true);
		expect((await ok("session.retry.abort")).ok).toBe(true);
	}, T);
});

describe("session info", () => {
	it("session.name.set renames the session", async () => {
		const r = await ok("session.name.set", { name: "functional-test" });
		expect(r.name).toBe("functional-test");
		expect(host.session.sessionName).toBe("functional-test");
	}, T);

	it("session.messages / stats / contextUsage / systemPrompt / lastAssistantText", async () => {
		expect(Array.isArray(await ok("session.messages"))).toBe(true);
		const stats = await ok("session.stats");
		expect(stats).toMatchObject({});
		expect(typeof stats).toBe("object");
		const usage = await ok("session.contextUsage");
		expect(usage).toBeTypeOf("object");
		expect(usage).not.toBeNull();
		expect(typeof usage.contextWindow).toBe("number");
		const prompt = await ok("session.systemPrompt");
		expect(prompt.length).toBeGreaterThan(100);
		// no assistant turn yet in this fresh session
		const last = await ok("session.lastAssistantText");
		expect(last === undefined || typeof last === "string").toBe(true);
		expect(Array.isArray(await ok("session.forkMessages"))).toBe(true);
	}, T);
});

describe("user bash (!)", () => {
	it("session.bash.run executes a command", async () => {
		const r = await ok("session.bash.run", { command: "echo functional-bash-ok" });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("functional-bash-ok");
	}, T);

	it("session.bash.record stores the result in the transcript", async () => {
		await ok("session.bash.record", { command: "echo recorded", result: { output: "recorded\n", exitCode: 0 } });
		expect(
			host.session.messages.some((m) => m.role === "bashExecution" && m.output.includes("recorded")),
		).toBe(true);
	}, T);

	it("session.bash.abort is a safe no-op", async () => {
		expect((await ok("session.bash.abort")).ok).toBe(true);
	}, T);
});

describe("import → tree → export → resume → fork → new", () => {
	it("session.import loads a JSONL session", async () => {
		const before = state.sent.length;
		const r = await ok("session.import", { path: importedJsonl });
		expect(r.cancelled).toBe(false);
		expect(host.session.messages.length).toBe(2);
		expect(await ok("session.lastAssistantText")).toBe("hi there");
		const forkable = await ok("session.forkMessages");
		expect(forkable.map((f) => f.entryId)).toContain("e2");
		expect(state.sent.slice(before).some(([c]) => c === "host:session-replaced")).toBe(true);
	}, T);

	it("sessions.list marks the live session", async () => {
		const all = await ok("sessions.list", { all: true });
		expect(Array.isArray(all)).toBe(true);
		expect(all.length).toBeGreaterThan(0);
		const current = all.find((s) => s.isCurrent);
		expect(current, "current session is listed").toBeTruthy();
		expect(current.path).toBe(host.session.sessionFile);
		expect(current).toHaveProperty("cwd");
		expect(current).toHaveProperty("messageCount");
		const scoped = await ok("sessions.list", { cwd });
		expect(scoped.some((s) => s.isCurrent)).toBe(true);
	}, T);

	it("sessions.delete validates paths", async () => {
		const outside = path.join(tmp, "outside.jsonl");
		fs.writeFileSync(outside, "{}");
		expect(await err("sessions.delete", { path: outside })).toBeTruthy();
		expect(fs.existsSync(outside)).toBe(true);
		expect(await err("sessions.delete", { path: host.session.sessionFile })).toBeTruthy();
	}, T);

	it("sessions.delete removes a stale session file", async () => {
		const dir = path.join(agentDir, "sessions", "--zfunc-fake--");
		fs.mkdirSync(dir, { recursive: true });
		const stale = path.join(dir, "stale.jsonl");
		fs.writeFileSync(stale, "{}");
		const r = await ok("sessions.delete", { path: stale });
		expect(r.ok).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	}, T);

	it("sessions.tree exposes entries, leaf and branch path", async () => {
		const tree = await ok("sessions.tree");
		expect(Array.isArray(tree.entries)).toBe(true);
		expect(tree.entries.length).toBeGreaterThan(0);
		expect(tree.leafId).toBeTruthy();
		expect(Array.isArray(tree.path)).toBe(true);
		const userEntry = tree.entries.find((e) => e.id === "e2");
		expect(userEntry).toMatchObject({ role: "user", text: "hello import" });
		expect(typeof tree.labels).toBe("object");
	}, T);

	it("sessions.setLabel bookmarks an entry", async () => {
		await ok("sessions.setLabel", { entryId: "e2", label: "bookmark" });
		const tree = await ok("sessions.tree");
		expect(Object.values(tree.labels)).toContain("bookmark");
		expect(host.session.sessionManager.getLabel("e2")).toBe("bookmark");
		// The label resolves onto its *target* entry (so [bookmark] renders on the
		// right row), while the label record row stays a hidden bookkeeping entry
		// with no label of its own.
		const target = tree.entries.find((e) => e.id === "e2");
		expect(target.label).toBe("bookmark");
		const records = tree.entries.filter((e) => e.role === "label");
		expect(records.length).toBeGreaterThan(0);
		for (const r of records) expect(r.label).toBeUndefined();
	}, T);

	it("sessions.setLabel rejects unknown entries", async () => {
		expect(await err("sessions.setLabel", { entryId: "nope", label: "x" })).toBeTruthy();
	}, T);

	it("session.exportHtml writes into the picked directory", async () => {
		const exportDir = path.join(tmp, "export");
		fs.mkdirSync(exportDir, { recursive: true });
		const out = await ok("session.exportHtml", { path: exportDir, themeName: "dark" });
		expect(out).toMatch(/\.html$/);
		expect(path.dirname(out)).toBe(exportDir);
		expect(fs.existsSync(out)).toBe(true);
		expect(fs.readFileSync(out, "utf8").toLowerCase()).toContain("<html");
	}, T);

	it("session.exportJsonl writes a replayable session file", async () => {
		const out = await ok("session.exportJsonl", { path: path.join(tmp, "exported.jsonl") });
		expect(fs.existsSync(out)).toBe(true);
		const lines = fs.readFileSync(out, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]).type).toBe("session");
	}, T);

	it("session.resume switches to the exported session", async () => {
		const before = state.sent.length;
		const r = await ok("session.resume", { path: path.join(tmp, "exported.jsonl") });
		expect(r.cancelled).toBe(false);
		expect(host.session.messages.length).toBe(2);
		expect(await ok("session.lastAssistantText")).toBe("hi there");
		expect(state.sent.slice(before).some(([c]) => c === "host:session-replaced")).toBe(true);
	}, T);

	it("session.fork branches at a user message", async () => {
		const beforeFile = host.session.sessionFile;
		const r = await ok("session.fork", { entryId: "e2", position: "before" });
		expect(r.cancelled).toBe(false);
		expect(host.session.sessionFile).not.toBe(beforeFile);
	}, T);

	it("session.new starts a fresh session", async () => {
		const beforeId = host.session.sessionId;
		const r = await ok("session.new");
		expect(r.cancelled).toBe(false);
		expect(host.session.sessionId).not.toBe(beforeId);
		expect(host.session.messages.length).toBe(0);
	}, T);

	it("session.reload re-binds and pushes a replacement", async () => {
		const before = state.sent.length;
		const r = await ok("session.reload");
		expect(r.ok).toBe(true);
		expect(state.sent.slice(before).some(([c]) => c === "host:session-replaced")).toBe(true);
	}, T);
});

describe("workspaces", () => {
	it("workspaces.list groups sessions by cwd (current first)", async () => {
		const list = await ok("workspaces.list");
		expect(Array.isArray(list)).toBe(true);
		const current = list.find((w) => w.isCurrent);
		expect(current, "current workspace is listed").toBeTruthy();
		expect(path.resolve(current.cwd)).toBe(path.resolve(cwd));
		expect(typeof current.sessionCount).toBe("number");
	}, T);

	it("workspaces.delete refuses the current workspace", async () => {
		expect(await err("workspaces.delete", { cwd })).toBeTruthy();
	}, T);

	it("workspaces.delete removes a workspace's session files", async () => {
		const fakeCwd = path.join(tmp, "fake-ws");
		const dir = sessionDirForCwd(fakeCwd);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "one.jsonl"), "{}");
		fs.writeFileSync(path.join(dir, "two.jsonl"), "{}");
		const r = await ok("workspaces.delete", { cwd: fakeCwd });
		expect(r).toEqual({ ok: true, deleted: 2 });
		expect(fs.existsSync(dir)).toBe(false);
	}, T);
});

describe("custom providers (models.json)", () => {
	it("models.config.read returns an empty config at first", async () => {
		const r = await ok("models.config.read");
		expect(r.path).toBe(path.join(agentDir, "models.json"));
		expect(r.providers).toEqual({});
	}, T);

	it("models.config.save round-trips a providers map", async () => {
		const providers = {
			funcprov: {
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "k-func",
				models: [{ id: "m1", name: "M1", contextWindow: 1000 }],
			},
		};
		const r = await ok("models.config.save", { providers });
		expect(r.ok).toBe(true);
		expect(fs.existsSync(r.path)).toBe(true);
		const back = await ok("models.config.read");
		expect(back.providers.funcprov?.models?.[0]?.id).toBe("m1");
	}, T);

	it("models.config.save rejects malformed payloads", async () => {
		expect(await err("models.config.save", { providers: [] })).toBeTruthy();
	}, T);
});

describe("MCP servers (mcp.json)", () => {
	// a stdio command that exits immediately: the MCP extension tries to
	// connect and fails fast — enough to exercise the config round-trip
	const flaky = { command: "node", args: ["-e", "process.exit(0)"] };

	it("mcp.read reports empty configs at first", async () => {
		const r = await ok("mcp.read");
		expect(r.user.path).toBe(path.join(agentDir, "mcp.json"));
		expect(r.user.servers).toEqual({});
		expect(r.project.path).toBe(path.join(cwd, ".pi", "mcp.json"));
		expect(r.project.servers).toEqual({});
		expect(typeof r.project.trusted).toBe("boolean");
	}, T);

	it("mcp.save round-trips a user-scope servers map", async () => {
		const r = await ok("mcp.save", {
			scope: "user",
			servers: { funcfs: { ...flaky, description: "d", exposure: "direct" } },
		});
		expect(r.ok).toBe(true);
		expect(fs.existsSync(r.path)).toBe(true);
		const back = await ok("mcp.read");
		expect(back.user.servers.funcfs?.command).toBe("node");
		expect(back.user.servers.funcfs?.exposure).toBe("direct");
		// leave no configured server behind for later tests
		await ok("mcp.save", { scope: "user", servers: {} });
		expect((await ok("mcp.read")).user.servers).toEqual({});
	}, T);

	it("mcp.save rejects malformed payloads", async () => {
		expect(await err("mcp.save", { servers: [] })).toBeTruthy();
	}, T);

	it("mcp.save project scope requires project trust", async () => {
		const initial = (await ok("trust.get")).trusted;
		try {
			await ok("trust.set", { trusted: false });
			expect(await err("mcp.save", { scope: "project", servers: { x: flaky } })).toBeTruthy();
			await ok("trust.set", { trusted: true });
			// a transport-less project entry is only valid as an override of a
			// user-level server with the same name; no such server exists yet
			expect(await err("mcp.save", { scope: "project", servers: { override: { enabled: false } } })).toBeTruthy();
			// a full entry (with transport) is fine in a trusted project
			const ok2 = await ok("mcp.save", { scope: "project", servers: { pproj: flaky } });
			expect(ok2.ok).toBe(true);
			expect(ok2.path).toBe(path.join(cwd, ".pi", "mcp.json"));
			await ok("mcp.save", { scope: "project", servers: {} });
		} finally {
			await ok("trust.set", { trusted: initial });
		}
	}, T);
});

describe("themes", () => {
	it("theme.list returns builtin + custom themes", async () => {
		const list = await ok("theme.list");
		expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(["dark", "light"]));
		expect(list.find((t) => t.name === "dark").builtin).toBe(true);
	}, T);

	it("theme.css resolves a builtin theme to CSS variables", async () => {
		const r = await ok("theme.css", { name: "dark" });
		expect(r.name).toBe("dark");
		expect(r.builtin).toBe(true);
		expect(Object.keys(r.vars).some((k) => k.startsWith("--"))).toBe(true);
	}, T);

	it("theme.css loads a custom theme from the agent dir", async () => {
		const themesDir = path.join(agentDir, "themes");
		fs.mkdirSync(themesDir, { recursive: true });
		fs.copyFileSync(
			path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "dark.json"),
			path.join(themesDir, "func-custom.json"),
		);
		const list = await ok("theme.list");
		const custom = list.find((t) => t.name === "func-custom");
		expect(custom).toBeTruthy();
		expect(custom.builtin).toBe(false);
		const r = await ok("theme.css", { name: "func-custom" });
		expect(r.builtin).toBe(false);
		expect(Object.keys(r.vars).some((k) => k.startsWith("--"))).toBe(true);
	}, T);

	it("theme.css reports unknown themes", async () => {
		const r = await ok("theme.css", { name: "does-not-exist" });
		expect(r.error).toBeTruthy();
	}, T);
});

describe("resources (extensions & skills)", () => {
	const skillDir = path.join(agentDir, "skills", "func-skill");
	const skillFile = path.join(skillDir, "SKILL.md");

	beforeAll(() => {
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			skillFile,
			"---\nname: func-skill\ndescription: A skill created by the functional test\n---\nDo the thing.\n",
		);
	});

	it("resources.get lists loaded prompts/skills/extensions/context files", async () => {
		const r = await ok("resources.get");
		expect(Array.isArray(r.prompts)).toBe(true);
		expect(Array.isArray(r.skills)).toBe(true);
		expect(Array.isArray(r.extensions)).toBe(true);
		expect(Array.isArray(r.extensionErrors)).toBe(true);
		expect(r.contextFiles.some((f) => f.path.endsWith("AGENTS.md"))).toBe(true);
	}, T);

	it("resources.changelog returns the package CHANGELOG", async () => {
		const r = await ok("resources.changelog");
		expect(typeof r).toBe("string");
		expect(r.length).toBeGreaterThan(0);
	}, T);

	it("resources.reload picks up the new skill", async () => {
		await ok("resources.reload");
		const r = await ok("resources.list");
		const skill = r.skills.find((s) => s.name === "func-skill");
		expect(skill, "skill is discovered").toBeTruthy();
		expect(skill.enabled).toBe(true);
		expect(skill.toggleable).toBe(true);
	}, T);

	it("resources.toggle disables and re-enables the skill", async () => {
		await ok("resources.toggle", { type: "skill", path: skillFile, enabled: false });
		let r = await ok("resources.list");
		expect(r.skills.find((s) => s.name === "func-skill").enabled).toBe(false);
		const skillPaths = host.session.settingsManager.getSkillPaths();
		expect(skillPaths.some((p) => p.startsWith("!") && p.includes("func-skill"))).toBe(true);

		await ok("resources.toggle", { type: "skill", path: skillFile, enabled: true });
		r = await ok("resources.list");
		expect(r.skills.find((s) => s.name === "func-skill").enabled).toBe(true);
		expect(host.session.settingsManager.getSkillPaths().some((p) => p.includes("func-skill"))).toBe(false);
	}, T);

	it("resources.toggle rejects unknown resources", async () => {
		expect(
			await err("resources.toggle", {
				type: "skill",
				path: path.join(agentDir, "skills", "ghost-skill", "SKILL.md"),
				enabled: false,
			}),
		).toBeTruthy();
	}, T);
});

describe("settings", () => {
	const before = {};

	beforeAll(async () => {
		const s = await ok("settings.get");
		for (const k of [
			"theme",
			"defaultThinkingLevel",
			"steeringMode",
			"followUpMode",
			"doubleEscapeAction",
			"treeFilterMode",
			"enabledModels",
			"externalEditorCommand",
			"httpIdleTimeoutMs",
			"hideThinkingBlock",
			"enableSkillCommands",
		]) {
			before[k] = s[k];
		}
	}, T);

	it("settings.get returns the full snapshot", async () => {
		const s = await ok("settings.get");
		expect(s).toHaveProperty("theme");
		expect(s).toHaveProperty("steeringMode");
		expect(s).toHaveProperty("compaction");
		expect(s).toHaveProperty("shellPath");
	}, T);

	it("settings.set round-trips supported keys", async () => {
		const set = (key, value) => ok("settings.set", { key, value });
		expect((await set("theme", "dark")).ok).toBe(true);
		expect((await set("hideThinkingBlock", true)).ok).toBe(true);
		expect((await set("steeringMode", "one-at-a-time")).ok).toBe(true);
		expect((await set("followUpMode", "one-at-a-time")).ok).toBe(true);
		expect((await set("doubleEscapeAction", "tree")).ok).toBe(true);
		expect((await set("treeFilterMode", "all")).ok).toBe(true);
		expect((await set("enableSkillCommands", false)).ok).toBe(true);
		expect((await set("externalEditorCommand", "code -w")).ok).toBe(true);
		expect((await set("httpIdleTimeoutMs", 123456)).ok).toBe(true);
		expect((await set("defaultThinkingLevel", "low")).ok).toBe(true);
		expect((await set("enabledModels", ["anthropic/*"])).ok).toBe(true);
		expect((await set("compaction", { enabled: true })).ok).toBe(true);
		expect((await set("retry", { enabled: true })).ok).toBe(true);

		const s = await ok("settings.get");
		expect(s.theme).toBe("dark");
		expect(s.hideThinkingBlock).toBe(true);
		expect(s.steeringMode).toBe("one-at-a-time");
		expect(s.followUpMode).toBe("one-at-a-time");
		expect(s.doubleEscapeAction).toBe("tree");
		expect(s.treeFilterMode).toBe("all");
		expect(s.enableSkillCommands).toBe(false);
		expect(s.externalEditorCommand).toBe("code -w");
		expect(s.httpIdleTimeoutMs).toBe(123456);
		expect(s.defaultThinkingLevel).toBe("low");
		expect(s.enabledModels).toEqual(["anthropic/*"]);
		expect(s.compaction.enabled).toBe(true);
		expect(s.retry.enabled).toBe(true);
	}, T);

	it("settings.set rejects unsupported keys", async () => {
		expect(await err("settings.set", { key: "bogusKey", value: 1 })).toContain("Unsupported");
	}, T);

	afterAll(async () => {
		for (const [key, value] of Object.entries(before)) {
			try {
				await ok("settings.set", { key, value });
			} catch {
				// sandboxed temp dir; cleanup failure is not a test failure
			}
		}
	}, T);
});

describe("project trust", () => {
	it("trust.get / trust.set", async () => {
		const initial = await ok("trust.get");
		expect(typeof initial.trusted).toBe("boolean");
		const r = await ok("trust.set", { trusted: true });
		expect(r).toEqual({ ok: true, trusted: true });
		expect((await ok("trust.get")).trusted).toBe(true);
		await ok("trust.set", { trusted: initial.trusted });
	}, T);
});

describe("extension / auth callbacks", () => {
	it("ext.ui.respond with an unknown id is a safe no-op", async () => {
		expect((await ok("ext.ui.respond", { id: "ghost", value: 1, cancelled: false })).ok).toBe(true);
	}, T);

	it("ext.editor.cache stores editor text for extensions", async () => {
		await ok("ext.editor.cache", { text: "cached editor text" });
		expect(host.session.extensionRunner).toBeTruthy();
	}, T);

	it("auth.respond with an unknown id is a safe no-op", async () => {
		expect((await ok("auth.respond", { id: "ghost", value: undefined, cancelled: true })).ok).toBe(true);
	}, T);
});

describe("workspace switching & shutdown", () => {
	it("system.reconfigure rejects an empty cwd", async () => {
		const r = await ok("system.reconfigure", {});
		expect(r.error).toBeTruthy();
	}, T);

	it("system.reconfigure switches the working directory", async () => {
		const cwd2 = path.join(tmp, "proj2");
		fs.mkdirSync(cwd2, { recursive: true });
		fs.writeFileSync(path.join(cwd2, "AGENTS.md"), "# second project\n");
		const readyBefore = pushed("host:ready").length;
		const r = await ok("system.reconfigure", { cwd: cwd2 });
		expect(r.ok).toBe(true);
		expect(host.runtime.cwd).toBe(path.resolve(cwd2));
		expect((await ok("host.snapshot")).cwd).toBe(path.resolve(cwd2));
		expect(pushed("host:ready").length).toBeGreaterThan(readyBefore);
	}, T);

	it("shutdown disposes the runtime and removes the IPC handler", async () => {
		expect(state.ipcHandlers.has("pi:invoke")).toBe(true);
		await host.shutdown();
		expect(state.ipcHandlers.has("pi:invoke")).toBe(false);
		expect(host.runtime).toBeNull();
		// idempotent
		await host.shutdown();
	}, T);
});
