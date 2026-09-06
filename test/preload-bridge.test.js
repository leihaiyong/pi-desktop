/**
 * Functional tests for the main-window preload bridge (src/preload/index.js).
 *
 * Verifies the exact surface the renderer receives via `window.pi` and the
 * envelope contract: main replies {ok, result|error}, the bridge unwraps
 * `{ok:true}` into a resolved value and converts `{ok:false}` into a reject.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
	exposed: null,
	invokeCalls: [],
	invokeResults: [],
	listeners: new Map(), // channel -> Set<fn>
}));

vi.mock("electron", () => ({
	contextBridge: {
		exposeInMainWorld: (name, api) => {
			state.exposed = { name, api };
		},
	},
	ipcRenderer: {
		invoke: async (channel, ...args) => {
			state.invokeCalls.push([channel, ...args]);
			const next = state.invokeResults.shift();
			if (next === undefined) return { ok: true, result: null };
			return next instanceof Error ? { ok: false, error: next.message } : next;
		},
		on: (channel, fn) => {
			if (!state.listeners.has(channel)) state.listeners.set(channel, new Set());
			state.listeners.get(channel).add(fn);
		},
		send: () => {},
		once: () => {},
	},
}));

import "../src/preload/index.js";

const api = () => {
	expect(state.exposed, "preload exposed window.pi").toBeTruthy();
	expect(state.exposed.name).toBe("pi");
	return state.exposed.api;
};

beforeEach(() => {
	state.invokeCalls = [];
	state.invokeResults = [];
});

describe("window.pi surface", () => {
	it("exposes the core invoke/on pair", () => {
		const p = api();
		expect(typeof p.invoke).toBe("function");
		expect(typeof p.on).toBe("function");
		expect(p.platform).toBe(process.platform);
		expect(p.versions).toMatchObject({});
	});

	it("exposes all documented convenience wrappers", () => {
		const p = api();
		for (const key of [
			"prompt",
			"steer",
			"followUp",
			"abort",
			"compact",
			"abortCompaction",
			"setModel",
			"cycleModel",
			"setThinking",
			"cycleThinking",
			"runBash",
			"abortBash",
			"listDisplays",
			"captureScreenshot",
			"startScreenshot",
			"notifyUiResponse",
			"respondAuth",
		]) {
			expect(typeof p[key], `window.pi.${key}`).toBe("function");
		}
	});
});

describe("envelope contract", () => {
	it("resolves with result on {ok:true}", async () => {
		state.invokeResults.push({ ok: true, result: 42 });
		const p = api();
		expect(await p.invoke("host.snapshot")).toBe(42);
	});

	it("rejects with the error message on {ok:false}", async () => {
		state.invokeResults.push({ ok: false, error: "boom" });
		const p = api();
		await expect(p.invoke("session.prompt", { text: "x" })).rejects.toThrow("boom");
	});

	it("always invokes over the single pi:invoke channel", async () => {
		const p = api();
		await p.invoke("host.snapshot", { a: 1 });
		expect(state.invokeCalls[0][0]).toBe("pi:invoke");
		expect(state.invokeCalls[0][1]).toBe("host.snapshot");
	});
});

describe("convenience wrappers map to the right channels", () => {
	const cases = [
		["prompt", () => api().prompt("hello", { streamingBehavior: "steer" }), "session.prompt", { text: "hello", streamingBehavior: "steer" }],
		["steer", () => api().steer("s"), "session.steer", { text: "s" }],
		["followUp", () => api().followUp("f"), "session.followUp", { text: "f" }],
		["abort", () => api().abort(), "session.abort", undefined],
		["compact", () => api().compact("focus"), "session.compact", { instructions: "focus" }],
		["abortCompaction", () => api().abortCompaction(), "session.compact.abort", undefined],
		["setModel", () => api().setModel("anthropic", "claude-x"), "session.model.set", { provider: "anthropic", id: "claude-x" }],
		["cycleModel", () => api().cycleModel(true), "session.model.cycle", { backward: true }],
		["setThinking", () => api().setThinking("low"), "session.thinking.set", { level: "low" }],
		["cycleThinking", () => api().cycleThinking(), "session.thinking.cycle", undefined],
		["runBash", () => api().runBash("ls", true), "session.bash.run", { command: "ls", excludeFromContext: true }],
		["abortBash", () => api().abortBash(), "session.bash.abort", undefined],
		["listDisplays", () => api().listDisplays(), "system.displays", undefined],
		["captureScreenshot", () => api().captureScreenshot(1), "system.screenshot", { index: 1 }],
		["startScreenshot", () => api().startScreenshot(), "system.screenshot.start", undefined],
		["notifyUiResponse", () => api().notifyUiResponse("ui-1", "v", false), "ext.ui.respond", { id: "ui-1", value: "v", cancelled: false }],
		["respondAuth", () => api().respondAuth("auth-1", "tok", true), "auth.respond", { id: "auth-1", value: "tok", cancelled: true }],
	];

	it.each(cases)("%s → %s", (_name, call, channel, params) => {
		call();
		expect(state.invokeCalls[0].slice(0, 2)).toEqual(["pi:invoke", channel]);
		if (params === undefined) {
			expect(state.invokeCalls[0][2]).toBeUndefined();
		} else {
			expect(state.invokeCalls[0][2]).toEqual(params);
		}
	});
});

describe("event subscription", () => {
	it("delivers payloads to subscribers and supports unsubscribe", () => {
		const p = api();
		const seen = [];
		const off = p.on("agent:event", (payload) => seen.push(payload));
		const listeners = state.listeners.get("agent:event");
		expect(listeners, "registered an ipc listener").toBeTruthy();
		const fn = [...listeners][0];

		fn(null, { type: "agent_start" });
		fn(null, { type: "agent_settled" });
		expect(seen.map((e) => e.type)).toEqual(["agent_start", "agent_settled"]);

		off();
		fn(null, { type: "message_start" });
		expect(seen.length).toBe(2);
	});

	it("supports multiple independent subscribers per channel", () => {
		const p = api();
		const a = [];
		const b = [];
		const offA = p.on("host:notify", (v) => a.push(v));
		p.on("host:notify", (v) => b.push(v));
		const fn = [...state.listeners.get("host:notify")][0];
		fn(null, { message: "hi" });
		expect(a).toEqual([{ message: "hi" }]);
		expect(b).toEqual([{ message: "hi" }]);
		offA();
		fn(null, { message: "again" });
		expect(a.length).toBe(1);
		expect(b.length).toBe(2);
	});
});
