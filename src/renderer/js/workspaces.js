/**
 * Workspace sidebar.
 *
 * A persistent, collapsible left sidebar that shows workspaces as a tree,
 * each workspace expandable to reveal its sessions. Replaces the old modal
 * picker. A workspace is a directory (the agent's cwd); its sessions live
 * under ~/.pi/agent/sessions/<encoded-cwd>/.
 *
 * Interactions:
 *   - caret (or clicking a workspace)     -> expand / collapse its sessions
 *   - double-click a workspace            -> open (switch to) that workspace
 *   - click a session                     -> open that session
 *   - hover a workspace, click the trash  -> two-step delete (not the current)
 *   - head "＋" button                    -> new workspace (pick a directory)
 *   - head "◀" button / titlebar ⌂        -> collapse / expand the whole sidebar
 */
import { formatTimestamp } from "../../shared/format.js";
import { t } from "../../shared/i18n.js";
import { openConfirmDialog } from "./modals.js";

const invoke = (channel, params) => window.pi.invoke(channel, params ?? {});

// action callbacks, provided by main.js
let onOpenWorkspace = () => {};
let onOpenSession = () => {};
let onNewWorkspace = () => {};
let onError = () => {};

let sidebarEl = null;
let treeEl = null;
let workspaces = [];
const expanded = new Set(); // cwds whose session list is expanded
const sessionsByCwd = {}; // cwd -> session[]
const loadingCwds = new Set(); // cwds with a fetch in flight
let busy = false;
let initialized = false;
let deleteArmed = null; // { key, run } of the armed (first-click) delete
let deleteArmedTimer = null;

function isOpen() {
	return !!sidebarEl && !sidebarEl.classList.contains("ws-collapsed");
}

function currentCwd() {
	const ws = workspaces.find((w) => w.isCurrent);
	return ws ? ws.cwd : "";
}

// ---------------------------------------------------------------- open/close

export function openWorkspaceSidebar() {
	if (!sidebarEl) return;
	sidebarEl.classList.remove("ws-collapsed");
	updateChrome();
	void refresh();
}
export function closeWorkspaceSidebar() {
	if (!sidebarEl) return;
	sidebarEl.classList.add("ws-collapsed");
	updateChrome();
}
export function toggleWorkspaceSidebar() {
	if (isOpen()) closeWorkspaceSidebar();
	else openWorkspaceSidebar();
}
export function isWorkspaceSidebarOpen() {
	return isOpen();
}
export function workspaceSidebarSetBusy(v) {
	busy = !!v;
}

function updateChrome() {
	// the thin expand strip is only visible while the sidebar is collapsed
	const btn = document.getElementById("ws-expand");
	if (btn) btn.hidden = isOpen();
}

// ---------------------------------------------------------------- init

export function initWorkspaceSidebar({ onOpenWorkspace: a, onOpenSession: b, onNewWorkspace: c, onError: d }) {
	onOpenWorkspace = a;
	onOpenSession = b;
	onNewWorkspace = c;
	onError = d ?? onError;
	sidebarEl = document.getElementById("ws-sidebar");
	treeEl = document.getElementById("ws-tree");
	if (!sidebarEl || !treeEl) return;
	if (initialized) return;
	initialized = true;

	document.getElementById("ws-new").addEventListener("click", () => {
		if (busy) return;
		onNewWorkspace();
	});
	document.getElementById("ws-collapse").addEventListener("click", closeWorkspaceSidebar);
	const expandBtn = document.getElementById("ws-expand");
	if (expandBtn) expandBtn.addEventListener("click", openWorkspaceSidebar);

	updateChrome();
	void refresh();
}

// ---------------------------------------------------------------- data

export async function refresh() {
	if (!initialized) return;
	try {
		workspaces = (await invoke("workspaces.list")) ?? [];
	} catch (e) {
		renderError(String(e));
		return;
	}
	// keep the current workspace expanded so the live session is visible
	const cur = currentCwd();
	if (cur) expanded.add(cur);

	// refresh the session lists of every expanded workspace (lazy-loaded)
	const todo = [...expanded];
	await Promise.all(todo.map((cwd) => loadSessions(cwd)));
	render();
	updateChrome();
}

async function loadSessions(cwd) {
	if (!cwd) return;
	if (loadingCwds.has(cwd)) return;
	loadingCwds.add(cwd);
	try {
		const list = (await invoke("sessions.list", { cwd })) ?? [];
		if (!workspaces.some((w) => w.cwd === cwd)) return;
		sessionsByCwd[cwd] = list;
	} catch {
		sessionsByCwd[cwd] = [];
	} finally {
		loadingCwds.delete(cwd);
	}
}

// ---------------------------------------------------------------- render

function renderError(msg) {
	if (!treeEl) return;
	treeEl.innerHTML = "";
	const d = document.createElement("div");
	d.className = "ws-sess-sub";
	d.textContent = msg;
	treeEl.appendChild(d);
}

export function render() {
	if (!treeEl) return;
	treeEl.innerHTML = "";
	if (workspaces.length === 0) {
		const d = document.createElement("div");
		d.className = "ws-sess-sub";
		d.textContent = t("ws.noWorkspaces");
		treeEl.appendChild(d);
		return;
	}
	for (const ws of workspaces) {
		treeEl.appendChild(renderNode(ws));
	}
}

function renderNode(ws) {
	const node = document.createElement("div");
	node.className = "ws-node";
	const isOpenNode = expanded.has(ws.cwd);

	// -- workspace row
	const row = document.createElement("div");
	row.className = "ws-ws-row" + (ws.isCurrent ? " is-current" : "");
	row.title = t("ws.wsRowHint");

	const caret = document.createElement("button");
	caret.className = "ws-caret";
	caret.textContent = isOpenNode ? "▾" : "▸";
	caret.title = t("ws.toggle");
	caret.addEventListener("click", (e) => {
		e.stopPropagation();
		toggleExpand(ws.cwd);
	});

	const name = document.createElement("span");
	name.className = "ws-ws-name";
	name.textContent = (ws.isCurrent ? "● " : "") + ws.name;

	const count = document.createElement("span");
	count.className = "ws-ws-count";
	count.title = ws.cwd;
	count.textContent = ws.sessionCount;

	row.append(caret, name, count);

	if (!ws.isCurrent) {
		const wKey = `ws:${ws.cwd}`;
		const del = document.createElement("button");
		del.className = "ws-del";
		del.textContent = "🗑";
		del.title = t("ws.deleteTitle");
		if (isArmed(wKey)) {
			del.classList.add("armed");
			del.textContent = "✓";
			del.title = t("ws.confirmDelete");
		}
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			armDelete(wKey, () => deleteWorkspace(ws));
		});
		row.append(del);
	}

	row.addEventListener("click", () => toggleExpand(ws.cwd));
	row.addEventListener("dblclick", () => openWorkspace(ws.cwd));
	node.appendChild(row);

	// -- sessions
	const list = document.createElement("div");
	list.className = "ws-sess-list" + (isOpenNode ? "" : " collapsed");
	if (isOpenNode) list.appendChild(renderSessions(ws));
	node.appendChild(list);
	return node;
}

function renderSessions(ws) {
	const wrap = document.createElement("div");
	wrap.style.display = "contents";
	const sessions = sessionsByCwd[ws.cwd];
	if (loadingCwds.has(ws.cwd) && !sessions) {
		const d = document.createElement("div");
		d.className = "ws-sess-row";
		const s = document.createElement("span");
		s.className = "ws-sess-sub";
		s.textContent = t("ws.loading");
		d.appendChild(s);
		wrap.appendChild(d);
		return wrap;
	}
	if (!sessions || sessions.length === 0) {
		const d = document.createElement("div");
		d.className = "ws-sess-row";
		const s = document.createElement("span");
		s.className = "ws-sess-sub";
		s.textContent = t("ws.noSessions");
		d.appendChild(s);
		wrap.appendChild(d);
		return wrap;
	}
	for (const s of sessions) {
		wrap.appendChild(renderSessionRow(ws, s));
	}
	return wrap;
}

function renderSessionRow(ws, s) {
	const row = document.createElement("div");
	row.className = "ws-sess-row" + (s.isCurrent ? " is-current" : "");
	const firstMsg = (s.title ?? "").trim().split(/\r?\n/)[0] ?? "";
	const label = s.name ? `★ ${s.name}` : firstMsg ? firstMsg.slice(0, 100) : s.path.split(/[\\/]/).pop();

	const name = document.createElement("span");
	name.className = "ws-sess-name";
	name.textContent = label;
	const sub = document.createElement("span");
	sub.className = "ws-sess-sub";
	sub.textContent = [
		s.messageCount ? t("ws.msgCount", { n: s.messageCount }) : "",
		s.updated ? formatTimestamp(s.updated) : "",
		s.isCurrent ? t("ws.current") : "",
	]
		.filter(Boolean)
		.join(" · ");
	row.append(name, sub);
	if (!s.isCurrent) {
		const del = document.createElement("button");
		del.className = "ws-sess-del";
		del.textContent = "🗑";
		del.title = t("ws.deleteSession");
		del.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (busy) return;
			const firstMsg = (s.title ?? "").trim().split(/\r?\n/)[0] ?? "";
			const label = s.name || firstMsg.slice(0, 100) || s.path.split(/[\\/]/).pop();
			const ok = await openConfirmDialog({
				title: t("modal.deleteSession"),
				message: t("ws.deleteSessionQ", { name: label }),
			});
			if (ok) await deleteSession(ws, s);
		});
		row.append(del);
	}
	row.addEventListener("click", (e) => {
		e.stopPropagation();
		openSession(ws.cwd, s);
	});
	return row;
}

// ---------------------------------------------------------------- actions

async function toggleExpand(cwd) {
	if (busy) return;
	if (expanded.has(cwd)) {
		expanded.delete(cwd);
	} else {
		expanded.add(cwd);
		if (!sessionsByCwd[cwd] && !loadingCwds.has(cwd)) {
			render(); // show a loading row, then refill
			await loadSessions(cwd);
		}
	}
	render();
}

function openWorkspace(cwd) {
	if (busy || !cwd) return;
	const cur = currentCwd();
	if (cwd === cur) {
		// already here — just make sure it's visible
		expanded.add(cwd);
		render();
		return;
	}
	busy = true;
	onOpenWorkspace(cwd);
}

function openSession(cwd, s) {
	if (busy || !s) return;
	busy = true;
	onOpenSession(cwd, s);
}

function disarmDelete() {
	deleteArmed = null;
	clearTimeout(deleteArmedTimer);
}

function isArmed(key) {
	return !!deleteArmed && deleteArmed.key === key;
}

// key identifies the armed element (stable across re-renders); run executes on confirm
function armDelete(key, run) {
	if (busy) return;
	if (isArmed(key)) {
		disarmDelete();
		void run();
		return;
	}
	disarmDelete();
	deleteArmed = { key, run };
	clearTimeout(deleteArmedTimer);
	deleteArmedTimer = setTimeout(() => {
		disarmDelete();
		render();
	}, 5000);
	render();
}

async function deleteWorkspace(ws) {
	busy = true;
	try {
		await invoke("workspaces.delete", { cwd: ws.cwd });
		expanded.delete(ws.cwd);
		delete sessionsByCwd[ws.cwd];
		await refresh();
	} catch (e) {
		onError(String(e?.message ?? e));
		try {
			await refresh();
		} catch {
			/* ignore */
		}
	} finally {
		busy = false;
	}
}

async function deleteSession(ws, s) {
	busy = true;
	try {
		await invoke("sessions.delete", { path: s.path });
		const list = sessionsByCwd[ws.cwd];
		if (Array.isArray(list)) sessionsByCwd[ws.cwd] = list.filter((x) => x.path !== s.path);
		await refresh();
	} catch (e) {
		onError(String(e?.message ?? e));
		try {
			await refresh();
		} catch {
			/* ignore */
		}
	} finally {
		busy = false;
	}
}
