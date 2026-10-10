/**
 * Pure helpers for editing mcp.json (MCP server config).
 *
 * mcp.json shape (see docs/mcp.md of @earendil-works/pi-coding-agent):
 *   { "mcpServers": { "<name>": { command?, args?, env?, cwd?, url?,
 *                                headers?, description?, enabled?,
 *                                exposure?, toolExposure?, timeout?,
 *                                oauth?, ... } },
 *     "autoEnableCodemode"?: boolean }
 *
 * Names may contain only letters, digits, `_` and `-`. Tools are named
 * `mcp__<server>__<tool>` where every character other than letters, digits
 * and `_` is replaced by `_`.
 */

import { stripUndefined } from "./model-config.js";

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse mcp.json text. Never throws; malformed input -> { ok: false }. */
export function parseMcpJson(text) {
	if (!text) return { ok: true, servers: {}, autoEnableCodemode: undefined };
	let doc;
	try {
		doc = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: String(error), servers: {}, autoEnableCodemode: undefined };
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
		return { ok: false, error: "not an object", servers: {}, autoEnableCodemode: undefined };
	}
	const servers =
		doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
			? doc.mcpServers
			: {};
	return { ok: true, servers, autoEnableCodemode: doc.autoEnableCodemode };
}

/** Serialize back to mcp.json text (2-space indent). `undefined` servers
 * writes the empty-config marker so a fresh file is still valid. */
export function serializeMcpJson(servers, autoEnableCodemode) {
	const doc = { mcpServers: servers ?? {} };
	if (autoEnableCodemode !== undefined) doc.autoEnableCodemode = autoEnableCodemode;
	return JSON.stringify(doc, null, 2) + "\n";
}

/** Server names: letters, digits, `_`, `-`, 1..64 chars. */
export function isValidServerName(name) {
	return NAME_RE.test(String(name ?? ""));
}

/** Normalized server segment used inside `mcp__<server>__<tool>` tool names
 * (`-` is replaced by `_`). */
export function mcpServerKey(name) {
	return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

/** Count of tools in `toolNames` registered by the given MCP server. */
export function serverToolCount(toolNames, serverName) {
	const prefix = `mcp__${mcpServerKey(serverName)}__`;
	return (toolNames ?? []).filter((n) => n.startsWith(prefix)).length;
}

/** One-line summary for list views. A project entry without command/url is
 * an override of the user-level server with the same name. */
export function serverSummary(server) {
	const s = server ?? {};
	const parts = [];
	if (s.command) parts.push(`${s.command}${s.args?.length ? " " + s.args.join(" ") : ""}`);
	else if (s.url) parts.push(s.url);
	else parts.push("override");
	if (s.exposure) parts.push(s.exposure);
	if (s.enabled === false) parts.push("disabled");
	return parts.join(" · ");
}

/** Return a new servers map with `draft` merged over the server at `name`
 * (appended when new). Unknown fields already in the file are preserved. */
export function upsertServer(servers, name, draft) {
	const next = { ...(servers ?? {}) };
	next[name] = { ...(next[name] ?? {}), ...stripUndefined(draft) };
	return next;
}

/** Edit an existing server entry: fields named in `draft` are replaced
 * (undefined values are dropped from the entry), all other fields — e.g.
 * env, headers, oauth, timeout — are preserved. */
export function updateServer(servers, name, draft) {
	const next = { ...(servers ?? {}) };
	const base = { ...next[name] };
	for (const key of Object.keys(draft ?? {})) delete base[key];
	next[name] = { ...base, ...stripUndefined(draft) };
	return next;
}

/** Return a new servers map without the server at `name`. */
export function removeServer(servers, name) {
	const next = { ...(servers ?? {}) };
	delete next[name];
	return next;
}

/** A project-scope entry without a transport is only valid as an override
 * of an existing user-level server with the same name. */
export function isMcpOverrideValid(name, server, userServers) {
	if (!server || typeof server !== "object") return false;
	if (server.command || server.url || server.type) return true;
	return Boolean(userServers && userServers[name]);
}
