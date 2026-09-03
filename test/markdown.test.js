import { describe, it, expect } from "vitest";
import { renderMarkdown, renderStreamingMarkdown, escapeHtml } from "../src/renderer/js/markdown.js";

describe("renderMarkdown", () => {
	it("escapes raw HTML tokens (no DOM injection from model output)", () => {
		const html = renderMarkdown("hi <img src=x onerror=alert(1)> there");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("escapes script tags", () => {
		const html = renderMarkdown("<script>window.pwned=1</script>");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	it("still renders fenced code blocks", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```");
		expect(html).toContain("<pre><code");
		expect(html).toContain("const x = 1;");
	});

	it("renders bold and lists", () => {
		const html = renderMarkdown("**bold** and\n- a\n- b");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<li>a</li>");
	});

	it("falls back to escaped text on bad input", () => {
		const html = renderMarkdown("");
		expect(html).toBe("");
	});
});

describe("renderStreamingMarkdown", () => {
	it("balances an unclosed ``` fence", () => {
		const html = renderStreamingMarkdown("text\n```js\nconst x");
		expect(html).toContain("<pre><code");
	});

	it("balances an unclosed ~~~ fence", () => {
		const html = renderStreamingMarkdown("text\n~~~\nconst x");
		expect(html).toContain("<pre><code");
	});

	it("does not double-close balanced fences", () => {
		const html = renderStreamingMarkdown("```\ncode\n```\nafter");
		expect(html).toContain("after");
		expect((html.match(/<pre>/g) ?? []).length).toBe(1);
	});
});

describe("escapeHtml", () => {
	it("escapes the dangerous characters", () => {
		expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
	});
});
