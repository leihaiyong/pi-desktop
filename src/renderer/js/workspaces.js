/**
 * Workspace picker.
 *
 * A workspace is a directory (the agent's cwd). The picker is a two-pane
 * master/detail view: workspaces on the left, the selected workspace's
 * sessions on the right. Opened automatically at startup (when no workspace
 * was chosen via CLI) and on demand from the titlebar / menu / /workspaces.
 */
import { formatTimestamp } from "../../shared/format.js";
import { t, tp } from "../../shared/i18n.js";

const invoke = (channel, params) => window.pi.invoke(channel, params ?? {});

export async function openWorkspacePicker({
	currentCwd,
	onOpenWorkspace,
	onOpenSession,
	onNewWorkspace,
	onClose,
}) {
	const root = document.getElementById("modal-root");

	// close whatever modal is open (shared keydown-handler slot from modals.js)
	if (root._keydownHandler) {
		document.removeEventListener("keydown", root._keydownHandler, { capture: true });
		root._keydownHandler = null;
	}
	root.hidden = false;
	root.innerHTML = "";

	const el = document.createElement("div");
	el.className = "modal modal-wide";
	el.innerHTML = `
		<div class="modal-header"><span>${escapeHtmlT(t("ws.title"))}</span><button class="modal-close" title="${escapeHtmlT(t("modal.close"))}">✕</button></div>
		<div class="ws-panes">
			<div class="ws-pane">
				<div class="ws-pane-title">${escapeHtmlT(t("ws.title"))} <span class="ws-hint">${escapeHtmlT(t("ws.wsHint"))}</span></div>
				<div class="ws-list ws-ws-list"></div>
			</div>
			<div class="ws-pane">
				<div class="ws-pane-title"><span class="ws-detail-title">${escapeHtmlT(t("ws.sessions"))}</span> <span class="ws-hint">${escapeHtmlT(t("ws.sessHint"))}</span></div>
				<div class="ws-list ws-sess-list"></div>
			</div>
		</div>
		<div class="ws-actions">
			<button class="ws-btn ws-new">${escapeHtmlT(t("ws.new"))}</button>
			<button class="ws-btn ws-delete" title="${escapeHtmlT(t("ws.deleteTitle"))}">${escapeHtmlT(t("ws.delete"))}</button>
			<span class="ws-status"></span>
		</div>
		<div class="modal-footer"><span class="mf-left"></span><span class="mf-right">${escapeHtmlT(t("ws.footer"))}</span></div>
	`;
	function escapeHtmlT(s) {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}
	root.appendChild(el);

	const wsListEl = el.querySelector(".ws-ws-list");
	const sessListEl = el.querySelector(".ws-sess-list");
	const detailTitle = el.querySelector(".ws-detail-title");
	const deleteBtn = el.querySelector(".ws-delete");
	const newBtn = el.querySelector(".ws-new");
	const statusEl = el.querySelector(".ws-status");

	let workspaces = [];
	let sessions = [];
	let wsSel = 0;
	let sessSel = 0;
	let focusPane = "ws"; // "ws" | "sess"
	let busy = false;

	function row(container, { main, sub = "", selected, mark = "" }) {
		const r = document.createElement("div");
		r.className = "ws-row" + (selected ? " selected" : "");
		const m = document.createElement("span");
		m.className = "ws-main";
		m.textContent = (mark ? mark + " " : "") + main;
		const s = document.createElement("span");
		s.className = "ws-sub";
		s.textContent = sub;
		r.append(m, s);
		container.appendChild(r);
	}

	function renderWorkspaces() {
		wsListEl.innerHTML = "";
		workspaces.forEach((ws, i) => {
			row(wsListEl, {
				main: ws.name,
				sub: `${ws.cwd} · ${tp("ws.sessions", ws.sessionCount)}${ws.isCurrent ? ` · ${t("ws.current")}` : ""}`,
				selected: focusPane === "ws" && i === wsSel,
				mark: ws.isCurrent ? "●" : "",
			});
		});
		deleteBtn.disabled = !workspaces[wsSel] || !!workspaces[wsSel]?.isCurrent;
	}

	function renderSessions() {
		sessListEl.innerHTML = "";
		if (!workspaces[wsSel]) {
			row(sessListEl, { main: t("ws.selectWorkspace"), sub: "" });
			return;
		}
		if (sessions.length === 0) {
			row(sessListEl, { main: t("ws.noSessions"), sub: "" });
			return;
		}
		sessions.forEach((s, i) => {
			const firstMsg = (s.title ?? "").trim().split(/\r?\n/)[0] ?? "";
			row(sessListEl, {
				main: s.name ? `★ ${s.name}` : firstMsg ? firstMsg.slice(0, 100) : s.path.split(/[\\/]/).pop(),
				sub: [s.messageCount ? t("ws.msgCount", { n: s.messageCount }) : "", s.updated ? formatTimestamp(s.updated) : "", s.isCurrent ? t("ws.current") : ""]
					.filter(Boolean)
					.join(" · "),
				selected: focusPane === "sess" && i === sessSel,
			});
		});
	}

	function render() {
		renderWorkspaces();
		renderSessions();
	}

	// Lightweight selection update: toggle classes instead of rebuilding the
	// rows. Rebuilding on every click replaces the DOM nodes, so the second
	// click of a double-click lands on a *different* element and the browser
	// never fires native dblclick — this is what made dblclick "open" dead.
	function updateSelection() {
		[...wsListEl.children].forEach((r, i) =>
			r.classList.toggle("selected", focusPane === "ws" && i === wsSel)
		);
		if (sessions.length > 0) {
			[...sessListEl.children].forEach((r, i) =>
				r.classList.toggle("selected", focusPane === "sess" && i === sessSel)
			);
		}
		deleteBtn.disabled = !workspaces[wsSel] || !!workspaces[wsSel]?.isCurrent;
	}

	async function loadSessions() {
		const ws = workspaces[wsSel];
		if (!ws) {
			sessions = [];
			detailTitle.textContent = t("ws.sessions");
			renderSessions();
			return;
		}
		detailTitle.textContent = t("ws.detailTitle", { name: ws.name });
		sessListEl.innerHTML = "";
		row(sessListEl, { main: t("ws.loading"), sub: "" });
		try {
			const list = (await invoke("sessions.list", { cwd: ws.cwd })) ?? [];
			if (ws.cwd !== workspaces[wsSel]?.cwd) return; // selection moved meanwhile
			sessions = list;
			sessSel = 0;
			renderSessions();
		} catch (error) {
			sessions = [];
			sessListEl.innerHTML = "";
			row(sessListEl, { main: String(error), sub: "" });
		}
	}

	function move(pane, delta) {
		const len = pane === "ws" ? workspaces.length : sessions.length;
		if (len === 0) return;
		if (pane === "ws") {
			wsSel = (wsSel + delta + len) % len;
			if (deleteArmed) disarmDelete();
			void loadSessions();
		} else {
			sessSel = (sessSel + delta + len) % len;
		}
		updateSelection();
		el.querySelector(`.ws-${pane}-list .ws-row.selected`)?.scrollIntoView({ block: "nearest" });
	}

	function status(msg) {
		statusEl.textContent = msg ?? "";
	}

	function openWorkspace(ws) {
		if (busy || !ws) return;
		busy = true;
		status(t("ws.opening", { name: ws.name }));
		onOpenWorkspace(ws.cwd, () => {
			busy = false;
		});
	}

	function openSession(s) {
		if (busy || !s) return;
		const ws = workspaces[wsSel];
		if (!ws) return;
		busy = true;
		status(t("ws.loadingSession"));
		onOpenSession(ws.cwd, s, () => {
			busy = false;
		});
	}

	// two-step inline confirm (a modal confirm dialog would close this one)
	let deleteArmed = null;
	let deleteArmedTimer = null;

	function disarmDelete() {
		deleteArmed = null;
		clearTimeout(deleteArmedTimer);
		deleteBtn.textContent = t("ws.delete");
		if (!statusMsg) status("");
	}
	let statusMsg = "";

	async function doDelete(ws) {
		busy = true;
		try {
			const res = await invoke("workspaces.delete", { cwd: ws.cwd });
			if (res?.error) throw new Error(res.error);
			statusMsg = t("ws.deleted", { name: ws.name, count: res.deleted });
			status(statusMsg);
			workspaces = (await invoke("workspaces.list")) ?? [];
			const idx = workspaces.findIndex((w) => w.cwd === ws.cwd);
			wsSel = idx >= 0 ? idx : Math.min(wsSel, workspaces.length - 1);
			sessSel = 0;
			await loadSessions();
			render();
		} catch (error) {
			statusMsg = String(error);
			status(statusMsg);
		} finally {
			busy = false;
		}
	}

	function deleteWorkspace() {
		const ws = workspaces[wsSel];
		if (!ws || ws.isCurrent || busy) return;
		if (deleteArmed === ws.cwd) {
			// second click within the window: execute
			const armedWs = ws;
			disarmDelete();
			void doDelete(armedWs);
			return;
		}
		deleteArmed = ws.cwd;
		deleteBtn.textContent = t("ws.confirmDelete");
		status(t("ws.deleteConfirm", { count: ws.sessionCount, name: ws.name }));
		clearTimeout(deleteArmedTimer);
		deleteArmedTimer = setTimeout(disarmDelete, 5000);
	}

	// mouse: single click focuses a row, double click activates it
	wsListEl.addEventListener("click", (e) => {
		const r = e.target.closest(".ws-row");
		const idx = r ? [...wsListEl.children].indexOf(r) : -1;
		if (idx >= 0) {
			if (idx !== wsSel) {
				wsSel = idx;
				if (deleteArmed) disarmDelete();
				void loadSessions();
			}
			focusPane = "ws";
			updateSelection();
		}
	});
	wsListEl.addEventListener("dblclick", () => openWorkspace(workspaces[wsSel]));
	sessListEl.addEventListener("click", (e) => {
		const r = e.target.closest(".ws-row");
		const idx = r ? [...sessListEl.children].indexOf(r) : -1;
		if (idx >= 0 && idx < sessions.length) {
			sessSel = idx;
			focusPane = "sess";
			updateSelection();
		}
	});
	sessListEl.addEventListener("dblclick", () => openSession(sessions[sessSel]));
	newBtn.addEventListener("click", () => onNewWorkspace());
	deleteBtn.addEventListener("click", () => void deleteWorkspace());
	el.querySelector(".modal-close").addEventListener("click", close);

	function handleKey(event) {
		if (event.key === "Escape") {
			event.preventDefault();
			if (deleteArmed) {
				disarmDelete();
				return;
			}
			close();
			return;
		}
		if (busy) return;
		if (event.ctrlKey && (event.key === "d" || event.key === "D")) {
			event.preventDefault();
			void deleteWorkspace();
			return;
		}
		if ((event.key === "n" || event.key === "N") && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			onNewWorkspace();
			return;
		}
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				move(focusPane, 1);
				break;
			case "ArrowUp":
				event.preventDefault();
				move(focusPane, -1);
				break;
			case "ArrowRight":
			case "Tab":
				event.preventDefault();
				focusPane = "sess";
				render();
				break;
			case "ArrowLeft":
				event.preventDefault();
				focusPane = "ws";
				render();
				break;
			case "Enter":
				event.preventDefault();
				if (focusPane === "ws") openWorkspace(workspaces[wsSel]);
				else openSession(sessions[sessSel]);
				break;
		}
	}
	document.addEventListener("keydown", handleKey, { capture: true });
	root._keydownHandler = handleKey;

	function close() {
		disarmDelete();
		document.removeEventListener("keydown", handleKey, { capture: true });
		if (root._keydownHandler === handleKey) root._keydownHandler = null;
		root.hidden = true;
		root.innerHTML = "";
		onClose?.();
	}

	renderWorkspaces();
	try {
		workspaces = (await invoke("workspaces.list")) ?? [];
		const idx = workspaces.findIndex((w) => w.cwd === currentCwd);
		wsSel = idx >= 0 ? idx : 0;
		await loadSessions();
		render();
	} catch (error) {
		status(String(error));
	}
}
