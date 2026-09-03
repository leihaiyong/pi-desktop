/**
 * Pure diff helpers shared between the renderer and tests.
 *
 * pi's `edit` tool returns `details.diff` (a colored/plain unified-ish diff
 * string) and `details.patch` (standard unified patch). We normalize both into
 * structured hunks the renderer can paint.
 */

export function parseUnifiedDiff(text) {
	const hunks = [];
	const lines = (text ?? "").split(/\r?\n/);
	let current = null;
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
			current = { header: line, lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) {
			// tolerate a file header before the first hunk
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("++")) {
			current.lines.push({ type: "add", text: line.slice(1) });
			added++;
		} else if (line.startsWith("-") && !line.startsWith("--")) {
			current.lines.push({ type: "del", text: line.slice(1) });
			removed++;
		} else if (line.startsWith(" ")) {
			current.lines.push({ type: "ctx", text: line.slice(1) });
		}
		// ignore "\" No newline" and other artifacts
	}
	return { hunks, added, removed };
}

/**
 * pi's edit tool details.diff is a compact rendering like:
 *   -1,3
 *   -old line
 *   +new line
 * plus context. Normalize to the same shape as parseUnifiedDiff.
 */
export function parseEditDiff(diffText) {
	const lines = (diffText ?? "").split(/\r?\n/);
	const hunks = [{ header: "", lines: [] }];
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (/^[-+]\d+(?:,\d+)?$/.test(line)) {
			const h = { header: line, lines: [] };
			hunks.push(h);
			continue;
		}
		const h = hunks[hunks.length - 1];
		if (line.startsWith("+")) {
			h.lines.push({ type: "add", text: line.slice(1) });
			added++;
		} else if (line.startsWith("-")) {
			h.lines.push({ type: "del", text: line.slice(1) });
			removed++;
		} else {
			h.lines.push({ type: "ctx", text: line });
		}
	}
	return { hunks: hunks.filter((h) => h.lines.length > 0), added, removed };
}

export function renderDiffToHtml(diffText) {
	const parsed = /^@@/.test((diffText ?? "").trim())
		? parseUnifiedDiff(diffText)
		: parseEditDiff(diffText);
	let html = "";
	for (const hunk of parsed.hunks) {
		if (hunk.header) {
			html += `<div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>`;
		}
		for (const line of hunk.lines) {
			const cls = line.type === "add" ? "diff-add" : line.type === "del" ? "diff-del" : "diff-ctx";
			const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
			html += `<div class="${cls}"><span class="diff-marker">${marker}</span><span class="diff-text">${escapeHtml(line.text)}</span></div>`;
		}
	}
	return html;
}

export function escapeHtml(text) {
	return (text ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function diffStats(diffText) {
	const parsed = /^@@/.test((diffText ?? "").trim()) ? parseUnifiedDiff(diffText) : parseEditDiff(diffText);
	return { added: parsed.added, removed: parsed.removed };
}
