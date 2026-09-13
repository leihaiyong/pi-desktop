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

	// Branch-based indent, mirroring pi's TUI tree-selector: a single-child
	// chain stays flat (indent 0) and the indent only grows at a branch point
	// (a node with >1 child) and for the first generation after a branch.
	// Counting every ancestor (the old behavior) drew a long linear
	// conversation as a deep staircase that ran off the right edge of the
	// modal. A breadth-first walk from the roots assigns each node its indent.
	const indentOf = new Map();
	const roots = entries.filter((e) => e.parentId == null || !byId.has(e.parentId));
	const queue = roots.map((r) => ({ id: r.id, indent: 0, justBranched: false }));
	for (const r of roots) indentOf.set(r.id, 0);
	for (let head = 0; head < queue.length; head++) {
		const { id, indent, justBranched } = queue[head];
		const kids = children.get(id) ?? [];
		const multipleChildren = kids.length > 1;
		const childIndent =
			multipleChildren || (justBranched && indent > 0) ? indent + 1 : indent;
		for (const k of kids) {
			if (indentOf.has(k.id)) continue; // defensive: cycles / duplicate ids
			indentOf.set(k.id, childIndent);
			queue.push({ id: k.id, indent: childIndent, justBranched: multipleChildren });
		}
	}

	const rows = [];
	for (const e of entries) {
		rows.push({ ...e, depth: indentOf.get(e.id) ?? 0, isLeaf: e.id === leafId });
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
