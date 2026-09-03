import { describe, expect, it } from "vitest";
import {
	parseHex,
	toHex,
	blend,
	withAlpha,
	luminance,
	resolveThemeToCssVars,
} from "../src/shared/theme.js";

const darkTheme = {
	name: "dark",
	vars: {
		text: "#d4d4d4",
		gray: "#808080",
		accent: "#8abeb7",
		green: "#b5bd68",
		red: "#cc6666",
	},
	colors: {
		text: "text",
		muted: "gray",
		accent: "accent",
		userMessageText: "text",
		toolTitle: "text",
		toolDiffAdded: "green",
		toolDiffRemoved: "red",
	},
	export: { pageBg: "#18181e", cardBg: "#1e1e24" },
};

const lightTheme = {
	name: "light",
	vars: {
		text: "#1f2328",
		teal: "#5a8080",
		blue: "#547da7",
	},
	colors: {
		text: "text",
		muted: "#6c6c6c",
		accent: "teal",
	},
	export: { pageBg: "#f8f8f8", cardBg: "#ffffff" },
};

describe("parseHex", () => {
	it("parses 6-digit hex", () => {
		expect(parseHex("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
	});
	it("expands 3-digit hex", () => {
		expect(parseHex("#f0a")).toEqual({ r: 255, g: 0, b: 170 });
	});
	it("rejects garbage and numbers", () => {
		expect(parseHex("red")).toBeNull();
		expect(parseHex(123)).toBeNull();
		expect(parseHex("#12345")).toBeNull();
	});
});

describe("toHex", () => {
	it("round-trips and clamps", () => {
		expect(toHex({ r: 255, g: 128, b: 0 })).toBe("#ff8000");
		expect(toHex({ r: 300, g: -5, b: 0.4 })).toBe("#ff0000");
	});
});

describe("blend / withAlpha / luminance", () => {
	it("blends toward a target channel", () => {
		expect(blend("#000000", 255, 0.5)).toBe("#808080");
	});
	it("returns null for unparseable input", () => {
		expect(blend("nope", 255, 0.5)).toBeNull();
	});
	it("builds rgba strings", () => {
		expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
		expect(withAlpha("bad", 0.5)).toBeNull();
	});
	it("computes luminance", () => {
		expect(luminance("#ffffff")).toBeCloseTo(1);
		expect(luminance("#000000")).toBeCloseTo(0);
		expect(luminance("#808080")).toBeCloseTo(0.502, 2);
		expect(luminance("nope")).toBeNull();
	});
});

describe("resolveThemeToCssVars", () => {
	it("resolves var references from a dark theme", () => {
		const vars = resolveThemeToCssVars(darkTheme);
		expect(vars["--bg"]).toBe("#18181e");
		expect(vars["--bg-panel"]).toBe("#1e1e24");
		expect(vars["--fg"]).toBe("#d4d4d4");
		expect(vars["--muted"]).toBe("#808080");
		expect(vars["--accent"]).toBe("#8abeb7");
		expect(vars["--diff-add-fg"]).toBe("#b5bd68");
		expect(vars["--diff-del-fg"]).toBe("#cc6666");
		expect(vars["--diff-add-bg"]).toMatch(/^rgba\(/);
	});

	it("detects light themes from page background", () => {
		const vars = resolveThemeToCssVars(lightTheme);
		expect(vars["--bg"]).toBe("#f8f8f8");
		expect(vars["--fg"]).toBe("#1f2328");
	});

	it("falls back to sensible defaults when colors are missing", () => {
		const vars = resolveThemeToCssVars({ name: "empty", colors: {}, export: {} });
		expect(vars["--bg"]).toBe("#101014");
		expect(vars["--fg"]).toBe("#e8e8f0");
		expect(vars["--accent"]).toBe("#7aa2f7");
	});

	it("rejects invalid input", () => {
		expect(resolveThemeToCssVars(null)).toBeNull();
		expect(resolveThemeToCssVars("x")).toBeNull();
	});

	it("guards against circular var references", () => {
		const vars = resolveThemeToCssVars({
			name: "cycle",
			vars: { a: "b", b: "a" },
			colors: { text: "a" },
		});
		expect(vars["--fg"]).toBe("#e8e8f0"); // falls back to dark default
	});
});
