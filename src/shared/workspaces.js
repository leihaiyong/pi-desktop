/**
 * Pure helpers for the workspace view.
 *
 * A workspace is a directory (the agent's cwd). pi stores that directory's
 * sessions under ~/.pi/agent/sessions/<encoded-cwd>/, so the set of workspaces
 * is derived from the sessions on disk (SDK SessionInfo rows carry `cwd`).
 */

/** Last path segment of a cwd, used as the workspace display name. */
export function workspaceName(cwd) {
	const parts = String(cwd ?? "")
		.split(/[\\/]+/)
		.filter(Boolean);
	return parts[parts.length - 1] || String(cwd ?? "");
}

// Available orderings for the workspace list.
export const WORKSPACE_SORTS = ["recent", "name"];

/**
 * Sort workspaces. The live workspace is always pinned first.
 *  - "recent" (default): most recently used first (lastModified, newest first)
 *  - "name": alphabetical (case-insensitive, natural numeric order)
 */
export function sortWorkspaces(list, mode = "recent") {
	const arr = [...(list ?? [])];
	arr.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (mode === "name") {
			const c = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
			return c !== 0 ? c : b.lastModified - a.lastModified;
		}
		return b.lastModified - a.lastModified;
	});
	return arr;
}

/**
 * Group session infos by cwd into workspaces.
 *
 * @param sessions rows like { cwd, modified, messageCount } (SDK SessionInfo)
 * @param opts.currentCwd the live workspace; pinned first even without sessions
 * @param opts.sort "recent" (last used first, default) or "name" (alphabetical)
 * @param opts.limit max workspaces to return (in the chosen order)
 * @param opts.sessionLimit max sessions to attach per workspace (recent first)
 * @returns [{ cwd, name, isCurrent, sessionCount, lastModified, sessions: [...] }]
 */
export function groupWorkspaces(sessions, { currentCwd = "", sort = "recent", limit = 100, sessionLimit = 50 } = {}) {
	const byCwd = new Map();
	for (const s of sessions ?? []) {
		const cwd = s.cwd ? String(s.cwd) : "";
		// pre-cwd sessions (old files) have no workspace — skip them
		if (!cwd) continue;
		let ws = byCwd.get(cwd);
		if (!ws) {
			ws = { cwd, sessionCount: 0, lastModified: 0, sessions: [] };
			byCwd.set(cwd, ws);
		}
		ws.sessionCount++;
		ws.sessions.push(s);
		const t = s.modified ? new Date(s.modified).getTime() : 0;
		if (Number.isFinite(t) && t > ws.lastModified) ws.lastModified = t;
	}

	const when = (s) => (s?.modified ? new Date(s.modified).getTime() || 0 : 0);
	const list = [...byCwd.values()].map((ws) => ({
		...ws,
		name: workspaceName(ws.cwd),
		isCurrent: ws.cwd === currentCwd,
		sessions: [...ws.sessions].sort((a, b) => when(b) - when(a)).slice(0, sessionLimit),
	}));

	// the live workspace is always shown, even before its first session file
	if (currentCwd && !byCwd.has(currentCwd)) {
		list.unshift({
			cwd: currentCwd,
			name: workspaceName(currentCwd),
			isCurrent: true,
			sessionCount: 0,
			lastModified: 0,
			sessions: [],
		});
	}

	return sortWorkspaces(list, sort).slice(0, limit);
}
