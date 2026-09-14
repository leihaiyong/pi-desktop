/**
 * Cross-session tree helpers.
 *
 * A session can be *forked* from another; the fork records its origin in
 * `parentSessionPath`. These helpers turn a flat list of session infos into a
 * forest (roots + children) and flatten it back to an indented display list,
 * mirroring the SDK's `buildSessionTree` / `flattenSessionTree` in
 * `modes/interactive/components/session-selector.js` — but using a pure path
 * normalizer (lowercase + "/" separators) instead of `realpath`, so this module
 * stays free of Node/DOM and is testable in vitest.
 *
 * Session shape (as produced by the host's `#sessionInfoFor`):
 *   { path, cwd, name?, parentSessionPath?, created, updated, title, messageCount, isCurrent? }
 */
import { t } from "./i18n.js";

// consistent, case/separator-insensitive key so a child's parentSessionPath
// matches its parent's path even when the two differ in case or slash style
const normPath = (p) => (p ? String(p).toLowerCase().replace(/\\/g, "/") : "");

const when = (s) => {
	const t = s?.updated ? new Date(s.updated).getTime() : 0;
	return Number.isFinite(t) ? t : 0;
};

/**
 * Build a forest from a flat session list, keyed by parentSessionPath.
 * A session whose parent is present in the list becomes that parent's child;
 * otherwise it is a root. Each level is ordered by the newest activity in the
 * subtree (newest first), so a recently-used branch keeps its group on top.
 *
 * @param sessions flat list of session infos
 * @returns root nodes shaped { session, children }
 */
export function buildSessionForest(sessions) {
	const list = Array.isArray(sessions) ? sessions : [];
	const byKey = new Map();
	for (const s of list) {
		const key = normPath(s?.path);
		if (!key || byKey.has(key)) continue;
		byKey.set(key, { session: s, children: [] });
	}
	const roots = [];
	for (const s of list) {
		const node = byKey.get(normPath(s?.path));
		if (!node) continue;
		const parentKey = normPath(s?.parentSessionPath);
		const parent = parentKey ? byKey.get(parentKey) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	// newest activity across each subtree (drives the ordering)
	const latest = (node) => {
		let t = when(node.session);
		for (const c of node.children) t = Math.max(t, latest(c));
		node._latest = t;
		return t;
	};
	for (const r of roots) latest(r);
	const order = (nodes) => {
		nodes.sort((a, b) => b._latest - a._latest);
		for (const n of nodes) order(n.children);
	};
	order(roots);
	return roots;
}

/**
 * Flatten a forest into an ordered, depth-annotated display list.
 * @param roots from buildSessionForest
 * @returns [{ session, depth }]
 */
export function flattenSessionForest(roots) {
	const out = [];
	const walk = (node, depth) => {
		out.push({ session: node.session, depth });
		for (const c of node.children) walk(c, depth + 1);
	};
	for (const r of roots) walk(r, 0);
	return out;
}

/**
 * Display label for a session: prefer the user name, else the first message
 * line, else the path basename. A named session is prefixed with a star so it
 * is visually distinct from auto-derived titles.
 */
export function sessionLabel(s) {
	const firstMsg = (String(s?.title ?? "").trim().split(/\r?\n/)[0] ?? "");
	if (s?.name) return `★ ${s.name}`;
	if (firstMsg) return firstMsg.slice(0, 100);
	const base = s?.path ? String(s.path).split(/[\\/]/).pop() : "";
	return base || t("ws.noTitle");
}
