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

/**
 * Group session infos by cwd into workspaces, most recently used first.
 *
 * @param sessions rows like { cwd, modified, messageCount } (SDK SessionInfo)
 * @param opts.currentCwd the live workspace; pinned first even without sessions
 * @param opts.limit max workspaces to return (newest first)
 * @returns [{ cwd, name, isCurrent, sessionCount, lastModified }]
 */
export function groupWorkspaces(sessions, { currentCwd = "", limit = 100 } = {}) {
	const byCwd = new Map();
	for (const s of sessions ?? []) {
		const cwd = s.cwd ? String(s.cwd) : "";
		// pre-cwd sessions (old files) have no workspace — skip them
		if (!cwd) continue;
		let ws = byCwd.get(cwd);
		if (!ws) {
			ws = { cwd, sessionCount: 0, lastModified: 0 };
			byCwd.set(cwd, ws);
		}
		ws.sessionCount++;
		const t = s.modified ? new Date(s.modified).getTime() : 0;
		if (Number.isFinite(t) && t > ws.lastModified) ws.lastModified = t;
	}

	const list = [...byCwd.values()].map((ws) => ({
		...ws,
		name: workspaceName(ws.cwd),
		isCurrent: ws.cwd === currentCwd,
	}));

	// the live workspace is always shown, even before its first session file
	if (currentCwd && !byCwd.has(currentCwd)) {
		list.unshift({
			cwd: currentCwd,
			name: workspaceName(currentCwd),
			isCurrent: true,
			sessionCount: 0,
			lastModified: 0,
		});
	}

	list.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return b.lastModified - a.lastModified;
	});
	return list.slice(0, limit);
}
