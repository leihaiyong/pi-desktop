/**
 * Pure helpers for the session tree view.
 */

/**
 * Flatten a list of session tree entries (id, parentId, ...) into rows with
 * depth, preserving document order but indented by tree depth.
 */
export function flattenTree(entries, leafId) {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const children = new Map();
	for (const e of entries) {
		const key = e.parentId ?? null;
		if (!children.has(key)) children.set(key, []);
		children.get(key).push(e);
	}

	const depthOf = (id, seen = new Set()) => {
		let d = 0;
		let cur = byId.get(id);
		while (cur && cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
			seen.add(cur.id);
			d++;
			cur = byId.get(cur.parentId);
		}
		return d;
	};

	const rows = [];
	for (const e of entries) {
		rows.push({ ...e, depth: depthOf(e.id), isLeaf: e.id === leafId });
	}
	return rows;
}

/**
 * Count branches (entries with more than one child).
 */
export function countBranches(entries) {
	const kids = new Map();
	for (const e of entries) {
		const key = e.parentId ?? null;
		kids.set(key, (kids.get(key) ?? 0) + 1);
	}
	return [...kids.values()].filter((n) => n > 1).length;
}
