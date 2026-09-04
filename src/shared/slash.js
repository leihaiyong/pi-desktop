/**
 * Slash command parsing (mirrors the TUI's command set).
 */

export const BUILTIN_COMMANDS = [
	{ name: "/help", description: "Show available commands and hotkeys" },
	{ name: "/new", description: "Start a new session" },
	{ name: "/workspaces", description: "Open the workspace picker (open / create / delete workspaces, load sessions)" },
	{ name: "/resume", description: "Pick a saved session to resume" },
	{ name: "/model", description: "Open model selector (optional search term)" },
	{ name: "/thinking", description: "Set or cycle thinking level (off|minimal|low|medium|high|xhigh|max)" },
	{ name: "/theme", description: "Change the color theme (dark|light)" },
	{ name: "/settings", description: "Open settings" },
	{ name: "/export", description: "Export session as HTML (optional output path)" },
	{ name: "/import", description: "Import a session JSONL file (path)" },
	{ name: "/share", description: "Export session as HTML and reveal it in the file manager" },
	{ name: "/copy", description: "Copy the last assistant message to the clipboard" },
	{ name: "/name", description: "Set the session display name" },
	{ name: "/session", description: "Show session info (id, file, stats)" },
	{ name: "/changelog", description: "Show the pi changelog" },
	{ name: "/hotkeys", description: "Show keyboard shortcuts" },
	{ name: "/fork", description: "Fork the session at a previous user message" },
	{ name: "/clone", description: "Clone the session up to a previous user message" },
	{ name: "/tree", description: "Open the session tree navigator" },
	{ name: "/trust", description: "Show or toggle project trust" },
	{ name: "/login", description: "Log in to a provider (OAuth or API key)" },
	{ name: "/logout", description: "Log out of a provider" },
	{ name: "/compact", description: "Compact the conversation (optional custom instructions)" },
	{ name: "/reload", description: "Reload extensions, skills, prompts, themes, context files" },
	{ name: "/debug", description: "Show system prompt and loaded resources" },
	{ name: "/scoped-models", description: "Configure the Ctrl+P model cycle list" },
	{ name: "/providers", description: "Custom providers (edit global models.json)" },
	{ name: "/extensions", description: "Browse and manage extensions (enable / disable, open in file manager)" },
	{ name: "/skills", description: "Browse and manage skills (enable / disable, open in file manager)" },
	{ name: "/arminsayshi", description: "Easter egg" },
	{ name: "/dementedelves", description: "Easter egg" },
	{ name: "/quit", description: "Quit Pi Desktop" },
];

/**
 * Split a user line into command + args.
 * Returns null when the line is not a slash command.
 */
export function parseSlashCommand(line) {
	if (!line || !line.startsWith("/")) return null;
	const trimmed = line.trim();
	const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/s);
	const name = (match ? match[1] : trimmed).toLowerCase();
	const args = match?.[2] ? match[2].trim() : "";
	return { name, args, raw: trimmed };
}

export function isSlashCommand(line) {
	return (line ?? "").trim().startsWith("/");
}

export function isBashCommand(line) {
	const t = (line ?? "").trim();
	return t.startsWith("!") && t.length > 1;
}

/**
 * Extract the shell command from a `!cmd` / `!!cmd` editor line.
 * `excluded` is true for the `!!` prefix (TUI: output is excluded from LLM context).
 */
export function extractBashCommand(line) {
	const t = (line ?? "").trim();
	const excluded = t.startsWith("!!");
	return { command: t.slice(excluded ? 2 : 1).trim(), excluded };
}

/**
 * Autocomplete candidates for the editor.
 * `text` is the current editor content; `caretLine` the line under the caret.
 */
export function completionContext(text, caret) {
	const upToCaret = (text ?? "").slice(0, caret ?? 0);
	const lines = upToCaret.split("\n");
	const currentLine = lines[lines.length - 1];
	const match = currentLine.match(/(^|\s)(\/[\w-]*|@[\w./-]*)$/);
	if (!match) return null;
	const token = match[2];
	return {
		kind: token.startsWith("/") ? "slash" : "file",
		token,
		tokenStart: currentLine.length - token.length,
		lineStartOffset: upToCaret.length - currentLine.length,
	};
}
