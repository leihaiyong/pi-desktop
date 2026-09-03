import { marked } from "../../../node_modules/marked/lib/marked.esm.js";

let configured = false;

function hl() {
	return globalThis.window?.hljs;
}

export function setupMarkdown() {
	if (configured) return;
	configured = true;
	const renderer = new marked.Renderer();
	renderer.code = function (code, infostring, escaped) {
		// marked v15 passes a token object
		const token = typeof code === "object" && code !== null ? code : { text: code, lang: infostring };
		const lang = (token.lang ?? "").trim().split(/\s+/)[0];
		const text = token.text ?? "";
		const lib = hl();
		let html;
		if (lang && lib?.getLanguage(lang)) {
			try {
				html = lib.highlight(text, { language: lang }).value;
			} catch {
				html = escapeHtml(text);
			}
		} else if (lib && text.length < 8000) {
			try {
				html = lib.highlightAuto(text).value;
			} catch {
				html = escapeHtml(text);
			}
		} else {
			html = escapeHtml(text);
		}
		return `<pre><code class="hljs language-${lang || "plaintext"}">${html}</code></pre>`;
	};
	// marked does not sanitize: raw HTML in model/tool output would be injected
	// into the DOM as-is. Render it as literal text instead.
	renderer.html = function (token) {
		const raw = typeof token === "object" && token !== null ? token.raw ?? token.text : String(token);
		return escapeHtml(raw);
	};
	marked.setOptions({ renderer, breaks: false, gfm: true });
}

export function escapeHtml(text) {
	return (text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Render markdown, returning HTML. Raw HTML tokens are escaped (see
 * setupMarkdown) so model output can never inject markup into the DOM.
 */
export function renderMarkdown(text) {
	setupMarkdown();
	if (!text) return "";
	try {
		const html = marked.parse(text, { async: false });
		return String(html);
	} catch (error) {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}

/**
 * Render a partial (streaming) markdown chunk. Streaming text may contain
 * unclosed code fences; balance them before rendering to avoid raw markup.
 */
export function renderStreamingMarkdown(text) {
	let balanced = text ?? "";
	for (const fence of ["```", "~~~"]) {
		const count = (balanced.match(new RegExp(`^${fence.replace(/[`~]/g, "\\$&")}`, "gm")) ?? []).length;
		if (count % 2 === 1) balanced += "\n" + fence;
	}
	return renderMarkdown(balanced);
}
