import { describe, it, expect } from "vitest";
import {
	BUILTIN_COMMANDS,
	parseSlashCommand,
	isSlashCommand,
	isBashCommand,
	extractBashCommand,
	completionContext,
} from "../src/shared/slash.js";

describe("parseSlashCommand", () => {
	it("parses command with args", () => {
		expect(parseSlashCommand("/model anthropic/claude-opus-4-5")).toEqual({
			name: "/model",
			args: "anthropic/claude-opus-4-5",
			raw: "/model anthropic/claude-opus-4-5",
		});
	});

	it("parses command without args", () => {
		expect(parseSlashCommand("/compact")).toEqual({
			name: "/compact",
			args: "",
			raw: "/compact",
		});
	});

	it("normalizes case", () => {
		expect(parseSlashCommand("/NEW").name).toBe("/new");
	});

	it("splits on any whitespace separator", () => {
		expect(parseSlashCommand("/model\tanthropic/claude")).toEqual({
			name: "/model",
			args: "anthropic/claude",
			raw: "/model\tanthropic/claude",
		});
		expect(parseSlashCommand("/export   a.html").args).toBe("a.html");
		expect(parseSlashCommand("/export\n\t\n").args).toBe("");
	});

	it("returns null for plain text", () => {
		expect(parseSlashCommand("hello world")).toBeNull();
		expect(parseSlashCommand("  /late")).toBeNull();
	});
});

describe("command set", () => {
	it("covers the full TUI slash command surface", () => {
		const names = BUILTIN_COMMANDS.map((c) => c.name);
		for (const expected of [
			"/help",
			"/new",
			"/resume",
			"/model",
			"/thinking",
			"/theme",
			"/settings",
			"/export",
			"/import",
			"/share",
			"/copy",
			"/name",
			"/session",
			"/changelog",
			"/hotkeys",
			"/fork",
			"/clone",
			"/tree",
			"/trust",
			"/login",
			"/logout",
			"/compact",
			"/reload",
			"/debug",
			"/scoped-models",
			"/providers",
			"/mcp",
			"/arminsayshi",
			"/dementedelves",
			"/quit",
		]) {
			expect(names, `missing ${expected}`).toContain(expected);
		}
	});
});

describe("bash commands", () => {
	it("detects ! commands", () => {
		expect(isBashCommand("!ls")).toBe(true);
		expect(isBashCommand("! ls")).toBe(true);
		expect(isBashCommand("!")).toBe(false);
		expect(isBashCommand("nope")).toBe(false);
	});

	it("extracts the command", () => {
		expect(extractBashCommand("!git status")).toEqual({ command: "git status", excluded: false });
	});

	it("detects the !! prefix (excluded from LLM context)", () => {
		expect(isBashCommand("!!ls")).toBe(true);
		expect(extractBashCommand("!!ls")).toEqual({ command: "ls", excluded: true });
		expect(extractBashCommand("!! git status")).toEqual({ command: "git status", excluded: true });
	});
});

describe("isSlashCommand", () => {
	it("detects leading slash", () => {
		expect(isSlashCommand("/x")).toBe(true);
		expect(isSlashCommand(" /x")).toBe(true);
		expect(isSlashCommand("x /y")).toBe(false);
	});
});

describe("completionContext", () => {
	it("finds slash tokens at line start", () => {
		const ctx = completionContext("/mod", 4);
		expect(ctx).toEqual({ kind: "slash", token: "/mod", tokenStart: 0, lineStartOffset: 0 });
	});

	it("finds file tokens after whitespace", () => {
		const ctx = completionContext("see @src/in", 11);
		expect(ctx?.kind).toBe("file");
		expect(ctx?.token).toBe("@src/in");
	});

	it("returns null mid-word", () => {
		expect(completionContext("abc/def", 7)).toBeNull();
	});

	it("uses caret position", () => {
		const ctx = completionContext("/new and more text", 4);
		expect(ctx?.token).toBe("/new");
	});
});
