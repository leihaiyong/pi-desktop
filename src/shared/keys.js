/**
 * Keybinding parsing/matching, compatible with pi's keybindings.json format:
 * `"ctrl+shift+x"`, arrays of strings, `super` alias.
 */

export function normalizeKeyCombo(combo) {
	const parts = String(combo).toLowerCase().split("+");
	const mods = new Set();
	let key = parts[parts.length - 1];
	for (const p of parts.slice(0, -1)) {
		if (p === "super" || p === "meta" || p === "cmd") mods.add("meta");
		else mods.add(p);
	}
	if (key === "esc") key = "escape";
	if (key === "return") key = "enter";
	if (key === "backspace") key = "backspace";
	return { mods: [...mods].sort(), key };
}

export function eventToCombo(event) {
	const mods = [];
	if (event.ctrlKey) mods.push("ctrl");
	if (event.altKey) mods.push("alt");
	if (event.shiftKey) mods.push("shift");
	if (event.metaKey) mods.push("meta");
	let key = (event.key ?? "").toLowerCase();
	if (key === " ") key = "space";
	if (key === "escape") key = "escape";
	return { mods: mods.sort(), key };
}

export function comboMatches(combo, event) {
	const a = normalizeKeyCombo(combo);
	const b = eventToCombo(event);
	return a.key === b.key && a.mods.length === b.mods.length && a.mods.every((m, i) => m === b.mods[i]);
}

export function comboLabel(combo, platform = "darwin") {
	const { mods, key } = normalizeKeyCombo(combo);
	const parts = [];
	const superName = platform === "win32" ? "Ctrl" : "⌘";
	for (const m of mods) {
		if (m === "ctrl") parts.push("Ctrl");
		else if (m === "alt") parts.push(platform === "darwin" ? "⌥" : "Alt");
		else if (m === "meta") parts.push(superName);
		else parts.push(m[0].toUpperCase() + m.slice(1));
	}
	const keyNames = {
		escape: "Esc",
		enter: "↵",
		tab: "Tab",
		backspace: "⌫",
		pageup: "PgUp",
		pagedown: "PgDn",
	};
	parts.push(keyNames[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)));
	return parts.join("+");
}

/**
 * Default desktop keybindings mirroring the TUI, with platform variants.
 * Values are arrays of combos in pi keybinding format.
 */
export function defaultBindings(platform) {
	const isWin = platform === "win32";
	return {
		"app.interrupt": ["escape"],
		"app.clear": ["ctrl+c"],
		"app.exit": ["ctrl+d"],
		"app.model.select": ["ctrl+l"],
		"app.model.cycleForward": ["ctrl+p"],
		"app.model.cycleBackward": isWin ? ["alt+p"] : ["shift+ctrl+p"],
		"app.thinking.cycle": ["shift+tab"],
		"app.thinking.toggle": ["ctrl+t"],
		"app.tools.expand": ["ctrl+o"],
		"app.message.copy": ["ctrl+x"],
		"app.message.followUp": isWin ? ["ctrl+q"] : ["alt+enter"],
		"app.message.dequeue": isWin ? ["alt+q"] : ["alt+up"],
		"app.editor.external": ["ctrl+g"],
		// alt+v on every platform: ctrl+v must stay free for native text paste
		// in the web editor (the TUI uses ctrl+v because terminals can't
		// distinguish image from text paste)
		"app.clipboard.pasteImage": ["alt+v"],
		"app.editor.screenshot": ["ctrl+shift+s"],
		"app.session.new": ["ctrl+n"],
		"app.session.tree": ["ctrl+shift+t"],
		"app.session.fork": ["ctrl+shift+f2"],
		"app.session.resume": ["ctrl+shift+r"],
		"app.session.rename": ["ctrl+r"],
		"app.session.delete": ["ctrl+backspace"],
		"app.input.newLine": ["shift+enter", "ctrl+j"],
		"app.input.submit": ["enter"],
		"app.input.tab": ["tab"],
		"app.transcript.search": isWin ? ["ctrl+f"] : ["ctrl+shift+f"],
		"app.transcript.top": ["ctrl+home"],
		"app.transcript.bottom": ["ctrl+end"],
		"app.transcript.previousPrompt": ["ctrl+shift+up"],
		"app.transcript.nextPrompt": ["ctrl+shift+down"],
		"app.history.previous": ["up"],
		"app.history.next": ["down"],
	};
}

/**
 * Build a lookup: combo string -> action id, given a bindings map plus
 * optional user overrides (pi keybindings.json shape).
 */
export function buildComboIndex(bindings, overrides = {}) {
	const merged = { ...bindings, ...overrides };
	const index = new Map();
	for (const [action, combos] of Object.entries(merged)) {
		for (const combo of Array.isArray(combos) ? combos : [combos]) {
			const { mods, key } = normalizeKeyCombo(combo);
			const normalized = [...mods, key].join("+");
			index.set(normalized, action);
		}
	}
	return index;
}
