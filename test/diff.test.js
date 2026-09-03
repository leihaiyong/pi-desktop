import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, parseEditDiff, diffStats, renderDiffToHtml, escapeHtml } from "../src/shared/diff.js";

describe("parseUnifiedDiff", () => {
	it("parses a standard unified patch", () => {
		const text = [
			"--- a/foo.ts",
			"+++ b/foo.ts",
			"@@ -1,3 +1,4 @@",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"+const c = 4;",
			" const d = 5;",
		].join("\n");
		const parsed = parseUnifiedDiff(text);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.added).toBe(2);
		expect(parsed.removed).toBe(1);
		expect(parsed.hunks[0].lines).toEqual([
			{ type: "ctx", text: "const a = 1;" },
			{ type: "del", text: "const b = 2;" },
			{ type: "add", text: "const b = 3;" },
			{ type: "add", text: "const c = 4;" },
			{ type: "ctx", text: "const d = 5;" },
		]);
	});

	it("handles multiple hunks and file headers", () => {
		const text = [
			"--- a/x",
			"+++ b/x",
			"@@ -1,2 +1,2 @@",
			"-old",
			"+new",
			"@@ -10,2 +10,2 @@",
			"-old2",
			"+new2",
		].join("\n");
		const parsed = parseUnifiedDiff(text);
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.added).toBe(2);
		expect(parsed.removed).toBe(2);
	});

	it("ignores no-newline artifacts", () => {
		const text = "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file";
		const parsed = parseUnifiedDiff(text);
		expect(parsed.added).toBe(1);
		expect(parsed.removed).toBe(1);
	});

	it("returns empty for empty input", () => {
		expect(parseUnifiedDiff("")).toEqual({ hunks: [], added: 0, removed: 0 });
	});
});

describe("parseEditDiff", () => {
	it("parses pi's edit tool compact diff", () => {
		const text = ["-2,1", "-old line", "+new line", "context line"].join("\n");
		const parsed = parseEditDiff(text);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.added).toBe(1);
		expect(parsed.removed).toBe(1);
		expect(parsed.hunks[0].header).toBe("-2,1");
	});
});

describe("diffStats", () => {
	it("counts additions and removals for unified diffs", () => {
		const stats = diffStats("@@ -1 +1 @@\n-a\n-b\n+c\n");
		expect(stats).toEqual({ added: 1, removed: 2 });
	});

	it("counts for edit-style diffs", () => {
		const stats = diffStats("-1,2\n-x\n-y\n+z\n");
		expect(stats).toEqual({ added: 1, removed: 2 });
	});
});

describe("renderDiffToHtml", () => {
	it("produces escaped html with line classes", () => {
		const html = renderDiffToHtml("@@ -1 +1 @@\n-<bad>\n+ok\n");
		expect(html).toContain("diff-del");
		expect(html).toContain("diff-add");
		expect(html).toContain("&lt;bad&gt;");
		expect(html).not.toContain("<bad>");
	});
});

describe("escapeHtml", () => {
	it("escapes all dangerous characters", () => {
		expect(escapeHtml(`<img src=x onerror="alert(1)"&>`)).toBe(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&amp;&gt;",
		);
	});
});
