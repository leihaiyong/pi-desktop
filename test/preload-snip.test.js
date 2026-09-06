/**
 * Functional tests for the snip (screen-region selection) preload
 * (src/preload/snip.js): it must receive the capture payload exactly once
 * and report selections / cancellations over the snip:* channels.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
	exposed: null,
	onceListeners: [], // [channel, fn]
	sent: [], // [channel, ...args]
}));

vi.mock("electron", () => ({
	contextBridge: {
		exposeInMainWorld: (name, api) => {
			state.exposed = { name, api };
		},
	},
	ipcRenderer: {
		once: (channel, fn) => {
			// mirrors electron semantics: the listener fires at most once
			const wrap = (...args) => {
				const i = state.onceListeners.findIndex((l) => l[1] === wrap);
				if (i < 0) return; // already fired
				state.onceListeners.splice(i, 1);
				fn(...args);
			};
			state.onceListeners.push([channel, wrap]);
		},
		send: (channel, ...args) => {
			state.sent.push([channel, ...args]);
		},
	},
}));

import "../src/preload/snip.js";

const api = () => {
	expect(state.exposed).toBeTruthy();
	expect(state.exposed.name).toBe("snip");
	return state.exposed.api;
};

beforeEach(() => {
	state.onceListeners = [];
	state.sent = [];
});

describe("window.snip", () => {
	it("exposes only onInit/select/cancel", () => {
		const p = api();
		expect(Object.keys(p).sort()).toEqual(["cancel", "onInit", "select"]);
	});

	it("onInit receives the capture payload exactly once", () => {
		const p = api();
		const seen = [];
		p.onInit((payload) => seen.push(payload));
		expect(state.onceListeners.length).toBe(1);
		const [channel, fn] = state.onceListeners[0];
		expect(channel).toBe("snip:init");

		const payload = { data: "AAA", mime: "image/png", imgW: 100, imgH: 50, lang: "en" };
		fn(null, payload);
		fn(null, payload); // second emission must be dropped (ipcRenderer.once)
		expect(seen).toEqual([payload]);
	});

	it("select reports the rect over snip:select", () => {
		api().select({ x: 1, y: 2, w: 30, h: 40 });
		expect(state.sent).toEqual([["snip:select", { x: 1, y: 2, w: 30, h: 40 }]]);
	});

	it("cancel reports over snip:cancel", () => {
		api().cancel();
		expect(state.sent).toEqual([["snip:cancel"]]);
	});
});
