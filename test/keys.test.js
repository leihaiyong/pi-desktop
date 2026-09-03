import { describe, it, expect } from "vitest";
import {
	normalizeKeyCombo,
	eventToCombo,
	comboMatches,
	comboLabel,
	defaultBindings,
	buildComboIndex,
} from "../src/shared/keys.js";

function fakeEvent({ key, ctrlKey = false, altKey = false, metaKey = false } = {}) {
	return { key, ctrlKey, altKey, metaKey };
}

describe("normalizeKeyCombo", () => {
	it("normalizes modifiers and keys", () => {
		expect(normalizeKeyCombo("Ctrl+Shift+F")).toEqual({ mods: ["ctrl", "shift"], key: "f" });
		expect(normalizeKeyCombo("esc")).toEqual({ mods: [], key: "escape" });
		expect(normalizeKeyCombo("super+k")).toEqual({ mods: ["meta"], key: "k" });
	});
});

describe("eventToCombo", () => {
	it("maps space and escape", () => {
		expect(eventToCombo(fakeEvent({ key: " " }))).toEqual({ mods: [], key: "space" });
		expect(eventToCombo(fakeEvent({ key: "Escape" }))).toEqual({ mods: [], key: "escape" });
	});
});

describe("comboMatches", () => {
	it("matches identical combos", () => {
		expect(comboMatches("ctrl+f", fakeEvent({ key: "f", ctrlKey: true }))).toBe(true);
		expect(comboMatches("ctrl+shift+f", { key: "f", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe(true);
	});

	it("distinguishes modifiers", () => {
		expect(comboMatches("f", fakeEvent({ key: "f", ctrlKey: true }))).toBe(false);
		expect(comboMatches("ctrl+f", fakeEvent({ key: "f", ctrlKey: true }))).toBe(true);
	});

	it("accepts shift combos", () => {
		// JS KeyboardEvent uses key "Tab" with shiftKey true
		expect(comboMatches("shift+tab", { key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: true })).toBe(true);
	});
});

describe("comboLabel", () => {
	it("renders mac labels", () => {
		expect(comboLabel("ctrl+shift+f", "darwin")).toBe("Ctrl+Shift+F");
	});

	it("renders special keys", () => {
		expect(comboLabel("escape", "darwin")).toBe("Esc");
		expect(comboLabel("enter", "darwin")).toBe("↵");
	});
});

describe("defaultBindings", () => {
	it("has platform variants", () => {
		const win = defaultBindings("win32");
		const mac = defaultBindings("darwin");
		expect(win["app.message.followUp"]).toEqual(["ctrl+q"]);
		expect(mac["app.message.followUp"]).toEqual(["alt+enter"]);
		// image paste uses alt+v everywhere so ctrl+v stays free for native
		// text paste in the web editor
		expect(win["app.clipboard.pasteImage"]).toEqual(["alt+v"]);
		expect(mac["app.clipboard.pasteImage"]).toEqual(["alt+v"]);
		// desktop-only: screen capture into the editor
		expect(win["app.editor.screenshot"]).toEqual(["ctrl+shift+s"]);
		expect(mac["app.editor.screenshot"]).toEqual(["ctrl+shift+s"]);
	});

	it("covers the core TUI actions", () => {
		const b = defaultBindings("darwin");
		for (const action of [
			"app.interrupt",
			"app.model.select",
			"app.model.cycleForward",
			"app.thinking.cycle",
			"app.tools.expand",
			"app.message.copy",
			"app.session.new",
			"app.session.tree",
			"app.session.fork",
			"app.session.resume",
			"app.input.newLine",
			"app.input.submit",
			"app.transcript.search",
			"app.transcript.previousPrompt",
			"app.transcript.nextPrompt",
		]) {
			expect(b[action], `missing ${action}`).toBeDefined();
		}
	});
});

describe("buildComboIndex", () => {
	it("normalizes combo order when indexing", () => {
		const index = buildComboIndex({ "app.model.cycleBackward": ["shift+ctrl+p"] });
		expect(index.get("ctrl+shift+p")).toBe("app.model.cycleBackward");
	});

	it("lets user overrides win", () => {
		const index = buildComboIndex({ "app.model.cycleForward": ["ctrl+p"] }, { "app.model.cycleForward": "f2" });
		expect(index.get("f2")).toBe("app.model.cycleForward");
		expect(index.get("ctrl+p")).toBeUndefined();
	});
});
