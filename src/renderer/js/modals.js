import { escapeHtml } from "./markdown.js";
import { formatTimestamp, formatTokens } from "../../shared/format.js";
import { flattenTree, countBranches } from "../../shared/tree.js";
import { sortWorkspaces, WORKSPACE_SORTS } from "../../shared/workspaces.js";
import { comboLabel } from "../../shared/keys.js";
import { t, tCmd, SUPPORTED_LANGUAGES } from "../../shared/i18n.js";
import { upsertProvider, removeProvider, stripUndefined, updateCostFields } from "../../shared/model-config.js";

/**
 * Modal framework + all TUI selector dialogs, re-implemented as web modals.
 */

const modalRoot = () => document.getElementById("modal-root");

function closeTop() {
	const root = modalRoot();
	// remove the open modal's global keydown handler so closed modals don't
	// accumulate listeners on document
	if (root._keydownHandler) {
		document.removeEventListener("keydown", root._keydownHandler, { capture: true });
		root._keydownHandler = null;
	}
	root.hidden = true;
	root.innerHTML = "";
	return true;
}

/** Close whatever modal is open (if any); used e.g. after a language switch. */
export function closeAnyOpenModal() {
	if (!modalRoot().hidden) closeTop();
}

function openModal({
	title,
	width = "modal",
	searchable = false,
	items = [],
	footer = "",
	onSelect,
	onKey,
	onClose,
	renderBody,
	stacked = false,
}) {
	closeTop();
	const root = modalRoot();
	root.hidden = false;
	const el = document.createElement("div");
	el.className = `modal ${width}`.trim();
	el.innerHTML = `
		<div class="modal-header"><span></span><button class="modal-close" title="${escapeHtml(t("modal.close"))}">✕</button></div>
		${searchable ? `<div class="modal-search"><input placeholder="${escapeHtml(t("modal.search"))}" /></div>` : ""}
		${renderBody ? '<div class="modal-body"></div>' : '<div class="modal-list"></div>'}
		<div class="modal-footer"><span class="mf-left"></span><span class="mf-right"></span></div>
	`;
	el.querySelector(".modal-header span").textContent = title;
	root.appendChild(el);

	let selected = 0;
	let query = "";
	let visible = items.slice();
	const listEl = el.querySelector(".modal-list");
	const searchEl = el.querySelector(".modal-search input");
	const footerEl = el.querySelector(".modal-footer");
	footerEl.querySelector(".mf-right").textContent = footer;

	function applyFilter() {
		if (!searchEl) {
			visible = items.slice();
			renderList();
			return;
		}
		const q = query.toLowerCase();
		visible = items.filter(
			(it) => !q || it.label.toLowerCase().includes(q) || (it.sub ?? "").toLowerCase().includes(q),
		);
		selected = Math.min(selected, Math.max(0, visible.length - 1));
		renderList();
	}

	function renderList() {
		listEl.innerHTML = "";
		if (visible.length === 0) {
			listEl.innerHTML = `<div class="modal-item"><span class="mi-sub">${escapeHtml(t("modal.noMatches"))}</span></div>`;
			return;
		}
		visible.forEach((it, i) => {
			const row = document.createElement("div");
			row.className =
				"modal-item" + (stacked ? " stacked" : "") + (it.cls ? ` ${it.cls}` : "") + (i === selected ? " selected" : "");
			const checkText = it.checked ? "✓" : it.mark ?? "";
			if (stacked) {
				row.innerHTML =
					`<div class="mi-l1"><span class="mi-main"></span><span class="mi-meta"></span><span class="mi-check"></span></div><div class="mi-detail"></div>`;
				row.querySelector(".mi-main").textContent = it.label;
				row.querySelector(".mi-meta").textContent = it.meta ?? "";
				row.querySelector(".mi-detail").textContent = it.sub ?? "";
			} else {
				row.innerHTML = `<span class="mi-main"></span><span class="mi-sub"></span><span class="mi-check"></span>`;
				row.querySelector(".mi-main").textContent = it.label;
				row.querySelector(".mi-sub").textContent = it.sub ?? "";
			}
			row.querySelector(".mi-check").textContent = checkText;
			row.addEventListener("click", () => {
				selected = i;
				choose(it);
			});
			row.addEventListener("mousemove", () => {
				if (selected !== i) {
					selected = i;
					renderList();
				}
			});
			listEl.appendChild(row);
		});
	}

	function choose(item) {
		if (item.disabled) return;
		if (onSelect) {
			const keep = onSelect(item);
			if (keep === false) return;
		}
		close();
	}

	function close() {
		if (onClose) onClose();
		closeTop();
	}

	function move(delta) {
		if (visible.length === 0) return;
		selected = (selected + delta + visible.length) % visible.length;
		renderList();
		listEl.querySelector(".modal-item.selected")?.scrollIntoView({ block: "nearest" });
	}

	function handleKey(event) {
		// ctx.selected is the currently highlighted item (post-filter)
		if (onKey?.(event, { selected: visible[selected], close }) === true) return;
		if (searchEl && document.activeElement === searchEl) {
			if (event.key === "Escape") {
				searchEl.blur();
			} else if (event.key === "Enter") {
				if (visible[selected]) choose(visible[selected]);
			}
			return;
		}
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				close();
				break;
			case "ArrowDown":
				event.preventDefault();
				move(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				move(-1);
				break;
			case "PageDown":
				event.preventDefault();
				move(10);
				break;
			case "PageUp":
				event.preventDefault();
				move(-10);
				break;
			case "Home":
				event.preventDefault();
				selected = 0;
				renderList();
				break;
			case "End":
				event.preventDefault();
				selected = visible.length - 1;
				renderList();
				break;
			case "Enter":
				event.preventDefault();
				if (visible[selected]) choose(visible[selected]);
				break;
			case "/":
				if (searchEl) {
					event.preventDefault();
					searchEl.focus();
				}
				break;
		}
	}

	document.addEventListener("keydown", handleKey, { capture: true });
	modalRoot()._keydownHandler = handleKey;
	el.querySelector(".modal-close").addEventListener("click", close);
	if (searchEl) {
		searchEl.addEventListener("input", () => {
			query = searchEl.value;
			applyFilter();
		});
	}
	if (renderBody) {
		const body = el.querySelector(".modal-body");
		renderBody(body, { close, footerEl });
	} else {
		applyFilter();
	}
	return {
		close,
		choose: (item) => choose(item),
	};
}

// ---------------------------------------------------------------- promises

export function openInputDialog({ title, placeholder = "", initial = "" }) {
	return new Promise((resolve) => {
		openModal({
			title,
			width: "narrow",
			renderBody: (body) => {
				body.innerHTML = `<input type="text" class="dlg-input" placeholder="${escapeHtml(placeholder)}" style="width:100%;font-size:calc(14px * var(--fs, 1.1429));padding:7px 10px" value="${escapeHtml(initial)}" />`;
				const input = body.querySelector("input");
				input.focus();
				input.select();
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						resolve(input.value);
						closeTop();
					}
				});
			},
			onClose: () => resolve(undefined),
		});
	});
}

export function openConfirmDialog({ title, message, confirmLabel = t("modal.confirm") }) {
	return new Promise((resolve) => {
		openModal({
			title,
			width: "narrow",
			renderBody: (body, { close }) => {
				body.innerHTML = `
					<p style="white-space:pre-wrap">${escapeHtml(message)}</p>
					<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
						<button class="btn-cancel" style="background:var(--bg-alt);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 14px;cursor:pointer">${escapeHtml(t("modal.cancel"))}</button>
						<button class="btn-ok" style="background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer">${escapeHtml(confirmLabel)}</button>
					</div>`;
				body.querySelector(".btn-ok").addEventListener("click", () => {
					resolve(true);
					close();
				});
				body.querySelector(".btn-cancel").addEventListener("click", () => {
					resolve(false);
					close();
				});
			},
			onKey: (e) => {
				if (e.key === "Enter") {
					resolve(true);
					closeTop();
					return true;
				}
			},
			onClose: () => resolve(false),
		});
	});
}

// ---------------------------------------------------------------- selectors

export function openModelSelector({ models, current, thinkingLevels, onPick, platform = "darwin" }) {
	// only models with active auth appear in the list; the current model is
	// kept visible even if it lost auth, so the dialog is never confusingly empty
	const visible = models.filter((m) => m.available || (current && current.provider === m.provider && current.id === m.id));
	const byProvider = new Map();
	for (const m of visible) {
		if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
		byProvider.get(m.provider).push(m);
	}
	const items = [];
	for (const [provider, list] of byProvider) {
		for (const m of list) {
			const isCurrent = current?.provider === m.provider && current?.id === m.id;
			items.push({
				label: isCurrent ? `● ${m.name}` : m.name,
				sub: `${m.provider}/${m.id} · ${formatTokens(m.contextWindow)} ctx${
					m.available ? "" : ` · ${t("modal.noAuth")}`
				}${m.cost ? ` · $${(m.cost.input / 1e6).toFixed(2)}/M in` : ""}`,
				disabled: !m.available,
				data: m,
			});
		}
	}
	openModal({
		title: t("modal.selectModel"),
		searchable: true,
		items,
		footer: t("modal.enterSelect"),
		onSelect: (item) => {
			// close after picking, like the TUI selector; feedback comes as a toast
			onPick(item.data);
		},
	});
}

export function openSessionSelector({ sessions, cwd, all = false, onPick, onRename, onDelete, onFork }) {
	const items = sessions.map((s) => {
		const project = s.cwd ? s.cwd.split(/[\\/]/).pop() : "";
		// like the TUI: named sessions show the name, otherwise the first
		// user message (not the file name)
		const firstMsg = (s.title ?? "").trim().split(/\r?\n/)[0] ?? "";
		const label = s.name ? `★ ${s.name}` : firstMsg ? firstMsg.slice(0, 100) : s.path.split(/[\\/]/).pop();
		const sub = [project, s.messageCount ? t("modal.msgCount", { n: s.messageCount }) : "", s.updated ? formatTimestamp(s.updated) : "", s.isCurrent ? t("modal.current") : ""]
			.filter(Boolean)
			.join(" · ");
		return {
			label,
			sub,
			data: s,
		};
	});
	openModal({
		title: t("modal.resumeSession"),
		searchable: true,
		items,
		footer: `${all ? t("modal.allProjects") : t("modal.project", { cwd })} · ${t("modal.sessionFooter")}`,
		onSelect: (item) => {
			// close after picking; an async onPick resolves later and never
			// returns false, only an explicit `return false` keeps the list open
			if (onPick(item.data) === false) return false;
		},
		onKey: async (e, ctx) => {
			// use the framework's selection, not a DOM/label lookup: named
			// sessions carry a "★ " prefix that broke label matching
			const item = ctx?.selected;
			if (!item) return;
			if (e.key === "Escape") return;
			if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
				e.preventDefault();
				const name = await openInputDialog({ title: t("modal.renameSession"), initial: item.data.name ?? "" });
				if (name !== undefined) onRename(item.data, name);
				return true;
			}
			if (e.ctrlKey && (e.key === "d" || e.key === "D")) {
				e.preventDefault();
				const ok = await openConfirmDialog({ title: t("modal.deleteSession"), message: t("modal.deleteSessionQ", { path: item.data.path }) });
				if (ok) onDelete(item.data);
				return true;
			}
			if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
				e.preventDefault();
				onFork?.(item.data);
				return true;
			}
		},
	});
}

// Startup workspace chooser: a modal that asks the user to open an existing
// workspace or create a new one. The list is sorted (most-recently-used or
// by name) and the live workspace is pinned/highlighted.
export function openWorkspacePicker({ workspaces, onPick, onNew, onSortChange, initialSort = "recent" }) {
	let sort = WORKSPACE_SORTS.includes(initialSort) ? initialSort : "recent";
	let selected = 0;
	const ordered = () => sortWorkspaces(workspaces ?? [], sort);
	openModal({
		title: t("ws.chooseTitle"),
		width: "wide",
		searchable: false,
		renderBody: (body, { close }) => {
			const rows0 = ordered();
			selected = Math.max(0, rows0.findIndex((w) => w.isCurrent));
			function render() {
				body.innerHTML = "";
				const rows = ordered();
				// toolbar: sort toggle (left) + new workspace (right)
				const bar = document.createElement("div");
				bar.className = "ws-pick-bar";
				for (const [mode, key] of [["recent", "ws.sortRecent"], ["name", "ws.sortName"]]) {
					const b = document.createElement("button");
					b.className = "ws-pick-sort" + (sort === mode ? " active" : "");
					b.textContent = t(key);
					b.addEventListener("click", () => {
						if (sort === mode) return;
						sort = mode;
						onSortChange?.(mode);
						render();
					});
					bar.appendChild(b);
				}
				const spacer = document.createElement("span");
				spacer.className = "tree-tspacer";
				bar.appendChild(spacer);
				const newBtn = document.createElement("button");
				newBtn.className = "tree-act";
				newBtn.textContent = "＋";
				newBtn.title = t("ws.new");
				newBtn.addEventListener("click", async () => {
					if (!onNew) return;
					if (await onNew()) close();
				});
				bar.appendChild(newBtn);
				body.appendChild(bar);

				const listEl = document.createElement("div");
				listEl.className = "ws-pick-list";
				rows.forEach((ws, i) => {
					const row = document.createElement("div");
					row.className = "ws-pick-row" + (i === selected ? " selected" : "") + (ws.isCurrent ? " is-current" : "");
					const name = document.createElement("span");
					name.className = "wsp-name";
					name.textContent = (ws.isCurrent ? "● " : "") + ws.name;
					const meta = document.createElement("span");
					meta.className = "wsp-meta";
					meta.textContent = [
						ws.sessionCount ? `${ws.sessionCount} ${t("ws.sessions")}` : "",
						ws.lastModified ? formatTimestamp(ws.lastModified) : "",
					]
						.filter(Boolean)
						.join(" · ");
					const p = document.createElement("span");
					p.className = "wsp-path";
					p.textContent = ws.cwd;
					row.append(name, meta, p);
					row.addEventListener("click", () => {
						selected = i;
						close();
						onPick?.(ws);
					});
					row.addEventListener("mousemove", () => {
						if (selected !== i) {
							selected = i;
							render();
						}
					});
					listEl.appendChild(row);
				});
				if (rows.length === 0) {
					const d = document.createElement("div");
					d.className = "ws-pick-empty";
					d.textContent = t("ws.noWorkspaces");
					listEl.appendChild(d);
				}
				body.appendChild(listEl);
				listEl.querySelector(".ws-pick-row.selected")?.scrollIntoView({ block: "nearest" });
			}
			render();
			body._handleKey = (e) => {
				const rows = ordered();
				if (!rows.length) return false;
				if (e.key === "ArrowDown") {
					e.preventDefault();
					selected = Math.min(rows.length - 1, selected + 1);
					render();
					return true;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					selected = Math.max(0, selected - 1);
					render();
					return true;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					close();
					onPick?.(rows[selected]);
					return true;
				}
				if (e.key === "n" || e.key === "N") {
					if (!onNew) return false;
					e.preventDefault();
					void (async () => {
						if (await onNew()) close();
					})();
					return true;
				}
				return false;
			};
		},
		onKey: (e) => modalRoot().querySelector(".modal-body")?._handleKey?.(e),
		footer: t("ws.chooseFooter"),
	});
}

// CSS class for a tree row, keyed by entry type/role, so different kinds of
// messages are visually distinguished (colored) in the tree view.
function treeRowClass(row) {
	if (row.type === "message") {
		if (row.role === "user") return "tr-user";
		if (row.role === "assistant") return "tr-assistant";
		if (row.role === "toolResult") return "tr-tool";
		if (row.role === "bashExecution") return "tr-bash";
		return "tr-msg";
	}
	switch (row.type) {
		case "compaction":
			return "tr-compaction";
		case "branch_summary":
			return "tr-branch";
		case "model_change":
			return "tr-model";
		case "thinking_level_change":
			return "tr-thinking";
		case "session_info":
			return "tr-title";
		case "label":
			return "tr-labeled";
		case "custom":
		case "custom_message":
			return "tr-custom";
		default:
			return "tr-meta";
	}
}

export function openTreeSelector({ tree, onNavigate, onFork, onClone, onLabel, filter = "default", reloadTree }) {
	// Mutable state so the tree can refresh in place after a fork/clone/navigate.
	let entries = tree.entries ?? [];
	let leafId = tree.leafId;
	let visibleRows = [];
	let selected = 0;
	// Active type filter, switched live from the toolbar buttons.
	let filterMode = filter;
	// Bookkeeping entries hidden by the "default" / "no-tools" views.
	const HIDDEN_DEFAULT = new Set(["model", "thinking", "session_info", "label", "custom"]);
	const matchFilter = (row) => {
		switch (filterMode) {
			case "user-only":
				return row.role === "user";
			case "no-tools":
				return !HIDDEN_DEFAULT.has(row.role) && row.role !== "toolResult";
			case "labeled-only":
				return row.label != null;
			case "all":
				return true;
			default:
				return !HIDDEN_DEFAULT.has(row.role);
		}
	};
	// A linear session (no branches) renders as a flat list; only a branched
	// tree uses depth indentation, so a long straight conversation isn't drawn
	// as a deep staircase.
	const useTree = () => countBranches(entries) > 0;
	const computeVisible = () => flattenTree(entries, leafId).filter(matchFilter);
	openModal({
		title: t("modal.sessionTreeTitle"),
		width: "wide",
		searchable: false,
		renderBody: (body) => {
			body.innerHTML = "";

			// toolbar: type filters (left) + actions (right)
			const toolbar = document.createElement("div");
			toolbar.className = "tree-toolbar";
			const FILTERS = [
				["default", "settings.default"],
				["no-tools", "settings.noTools"],
				["user-only", "settings.userOnly"],
				["labeled-only", "settings.labeledOnly"],
				["all", "settings.all"],
			];
			const filterGroup = document.createElement("div");
			filterGroup.className = "tree-filters";
			const filterBtns = [];
			for (const [mode, key] of FILTERS) {
				const b = document.createElement("button");
				b.className = "tree-fbtn";
				b.textContent = t(key);
				b.addEventListener("click", () => setFilter(mode));
				filterGroup.appendChild(b);
				filterBtns.push([mode, b]);
			}
			toolbar.appendChild(filterGroup);
			const spacer = document.createElement("span");
			spacer.className = "tree-tspacer";
			toolbar.appendChild(spacer);
			const actionGroup = document.createElement("div");
			actionGroup.className = "tree-acts";
			const btn = (icon, title, kind) => {
				const b = document.createElement("button");
				b.className = "tree-act";
				b.textContent = icon;
				b.title = title;
				b.addEventListener("click", () => void act(kind));
				return b;
			};
			actionGroup.append(
				btn("→", t("modal.treeNav"), "navigate"),
				btn("⑂", t("modal.treeFork"), "fork"),
				btn("⑃", t("modal.treeBranch"), "clone"),
				btn("✎", t("modal.setLabel"), "label"),
			);
			toolbar.appendChild(actionGroup);
			body.appendChild(toolbar);

			const refreshFilterActive = () => {
				for (const [mode, b] of filterBtns) b.classList.toggle("active", mode === filterMode);
			};
			function setFilter(mode) {
				if (filterMode === mode) return;
				filterMode = mode;
				visibleRows = computeVisible();
				refreshFilterActive();
				selectLeaf();
				render();
			}

			const listEl = document.createElement("div");
			listEl.className = "tree-list";
			body.appendChild(listEl);

			function render() {
				const asTree = useTree();
				listEl.innerHTML = "";
				visibleRows.forEach((row, i) => {
					const div = document.createElement("div");
					div.className = `tree-row ${treeRowClass(row)}` + (i === selected ? " selected" : "") + (row.isLeaf ? " leaf" : "");
					const indent = "\u00A0".repeat((asTree ? row.depth : 0) * 2 + 1);
					div.innerHTML = `<span class="t-depth">${indent}${row.isLeaf ? "▶ " : ""}</span><span class="t-role">${escapeHtml(row.role ?? row.type)}</span><span class="t-label">${
						row.label ? `[${escapeHtml(row.label)}] ` : ""
					}</span><span class="t-text"></span><span class="t-time">${row.timestamp ? formatTimestamp(row.timestamp).slice(5) : ""}</span>`;
					div.querySelector(".t-text").textContent = row.text || t("modal.noText");
					div.addEventListener("click", () => {
						selected = i;
						render();
					});
					div.addEventListener("dblclick", () => void act("navigate"));
					listEl.appendChild(div);
				});
			}

			function selectLeaf() {
				selected = visibleRows.findIndex((r) => r.isLeaf);
				if (selected < 0) selected = visibleRows.length - 1;
				if (selected < 0) selected = 0;
			}

			async function act(kind) {
				const row = visibleRows[selected];
				if (!row) return;
				if (kind === "navigate") await onNavigate(row);
				else if (kind === "fork") await onFork?.(row);
				else if (kind === "clone") await onClone?.(row);
				else if (kind === "label") {
					const label = await openInputDialog({ title: t("modal.setLabel"), initial: row.label ?? "" });
					if (label !== undefined) await onLabel?.(row, label);
				}
				if (kind !== "label" && typeof reloadTree === "function") {
					const fresh = await reloadTree();
					if (fresh) {
						entries = fresh.entries ?? [];
						leafId = fresh.leafId;
						visibleRows = computeVisible();
						selectLeaf();
						render();
					}
				}
			}

			visibleRows = computeVisible();
			selectLeaf();
			refreshFilterActive();
			render();

			body._handleKey = (e) => {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					selected = Math.min(visibleRows.length - 1, selected + 1);
					render();
					return true;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					selected = Math.max(0, selected - 1);
					render();
					return true;
				}
				// Ctrl+Enter (fork) must be tested before plain Enter (navigate),
				// otherwise Enter always wins and fork is unreachable.
				if (e.ctrlKey && e.key === "Enter") {
					e.preventDefault();
					void act("fork");
					return true;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					void act("navigate");
					return true;
				}
				if (e.shiftKey && (e.key === "l" || e.key === "L")) {
					e.preventDefault();
					void act("label");
					return true;
				}
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
					e.preventDefault();
					void act("clone");
					return true;
				}
			};
		},
		onKey: (e) => {
			const handler = modalRoot().querySelector(".modal-body")?._handleKey;
			return handler?.(e);
		},
		footer: t("modal.treeFooter"),
	});
}

export function openSettings({
	settings,
	tools,
	activeTools,
	themeOptionsList = [],
	language,
	onChange,
	onToolsChange,
	onLanguageChange,
	appVersion,
	onEditProviders,
}) {
	openModal({
		title: t("settings.title"),
		width: "wide",
		renderBody: (body) => {
			const row = (label, control) => {
				const div = document.createElement("div");
				div.className = "setting-row";
				const span = document.createElement("span");
				span.textContent = label;
				div.appendChild(span);
				div.appendChild(control);
				body.appendChild(div);
			};
			const section = (title) => {
				const div = document.createElement("div");
				div.className = "section-title";
				div.textContent = title;
				body.appendChild(div);
			};
			const select = (options, value, onPick) => {
				const sel = document.createElement("select");
				for (const [val, label] of options) {
					const opt = document.createElement("option");
					opt.value = val;
					opt.textContent = label;
					if (val === value) opt.selected = true;
					sel.appendChild(opt);
				}
				sel.addEventListener("change", () => onPick(sel.value));
				return sel;
			};
			const checkbox = (checked, onPick) => {
				const input = document.createElement("input");
				input.type = "checkbox";
				input.checked = !!checked;
				input.addEventListener("change", () => onPick(input.checked));
				return input;
			};

			section(t("settings.models"));
			const providersBtn = document.createElement("button");
			providersBtn.textContent = t("modal.edit");
			providersBtn.style.cssText = "background:var(--bg-alt);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 14px;cursor:pointer";
			providersBtn.addEventListener("click", () => onEditProviders?.());
			row(t("settings.providers"), providersBtn);
			row(
				t("settings.defaultThinking"),
				select(
					[
						["", t("settings.auto")],
						["off", "off"],
						["minimal", "minimal"],
						["low", "low"],
						["medium", "medium"],
						["high", "high"],
						["xhigh", "xhigh"],
						["max", "max"],
					],
					settings.defaultThinkingLevel ?? "",
					(v) => onChange("defaultThinkingLevel", v || undefined),
				),
			);

			section(t("settings.queue"));
			row(
				t("settings.steeringMode"),
				select(
					[
						["all", t("settings.all")],
						["one-at-a-time", t("settings.oneAtATime")],
					],
					settings.steeringMode,
					(v) => onChange("steeringMode", v),
				),
			);
			row(
				t("settings.followUpMode"),
				select(
					[
						["all", t("settings.all")],
						["one-at-a-time", t("settings.oneAtATime")],
					],
					settings.followUpMode,
					(v) => onChange("followUpMode", v),
				),
			);

			section(t("settings.compaction"));
			row(
				t("settings.enabled"),
				checkbox(settings.compaction?.enabled, (v) => onChange("compaction", { enabled: v })),
			);
			row(
				t("settings.autoRetry"),
				checkbox(settings.retry?.enabled, (v) => onChange("retry", { enabled: v })),
			);
			row(t("settings.hideThinking"), checkbox(settings.hideThinkingBlock, (v) => onChange("hideThinkingBlock", v)));
			row(
				t("settings.showImages"),
				checkbox(settings.showImages, (v) => onChange("showImages", v)),
			);
			row(t("settings.blockImages"), checkbox(settings.blockImages, (v) => onChange("blockImages", v)));
			row(
				t("settings.imageAutoResize"),
				checkbox(settings.imageAutoResize, (v) => onChange("imageAutoResize", v)),
			);
			row(t("settings.quietStartup"), checkbox(settings.quietStartup, (v) => onChange("quietStartup", v)));

			section(t("settings.toolsActive"));
			const toolsRow = document.createElement("div");
			toolsRow.className = "setting-row";
			toolsRow.style.alignItems = "flex-start";
			const toolsLabel = document.createElement("span");
			toolsLabel.textContent = t("settings.enableTools");
			toolsLabel.style.minWidth = "140px";
			toolsLabel.style.paddingTop = "4px";
			toolsRow.appendChild(toolsLabel);
			const toolsBox = document.createElement("span");
			toolsBox.style.display = "flex";
			toolsBox.style.flexWrap = "wrap";
			toolsBox.style.gap = "6px";
			for (const tool of tools) {
				const label = document.createElement("label");
				const input = document.createElement("input");
				input.type = "checkbox";
				input.checked = activeTools.includes(tool.name);
				input.style.width = "auto";
				input.addEventListener("change", () => {
					const base = activeTools.filter((n) => n !== tool.name);
					onToolsChange(input.checked ? [...base, tool.name] : base);
				});
				label.appendChild(input);
				label.appendChild(document.createTextNode(` ${tool.name}${tool.isCustom ? " *" : ""}`));
				toolsBox.appendChild(label);
			}
			toolsRow.appendChild(toolsBox);
			body.appendChild(toolsRow);

			section(t("settings.appearance"));
			row(
				t("settings.language"),
				select(
					SUPPORTED_LANGUAGES.map((l) => [l.id, l.label]),
					language ?? "en",
					(v) => onLanguageChange?.(v),
				),
			);
			const themeOptions = themeOptionsList.length
				? themeOptionsList.map((th) => [th.name, th.builtin ? th.name : `${th.name} ${t("settings.custom")}`])
				: [
						["dark", "dark"],
						["light", "light"],
					];
			row(
				t("settings.theme"),
				select(themeOptions, settings.theme ?? "light", (v) => onChange("theme", v)),
			);
			row(
				t("settings.doubleEscape"),
				select(
					[
						["fork", t("settings.fork")],
						["tree", t("settings.tree")],
						["none", t("settings.none")],
					],
					settings.doubleEscapeAction ?? "fork",
					(v) => onChange("doubleEscapeAction", v),
				),
			);
			row(
				t("settings.treeFilter"),
				select(
					[
						["default", t("settings.default")],
						["no-tools", t("settings.noTools")],
						["user-only", t("settings.userOnly")],
						["labeled-only", t("settings.labeledOnly")],
						["all", t("settings.all")],
					],
					settings.treeFilterMode ?? "default",
					(v) => onChange("treeFilterMode", v),
				),
			);

			section(t("settings.about"));
			const versionValue = document.createElement("span");
			versionValue.textContent = appVersion ? `Pi Desktop v${appVersion}` : "Pi Desktop";
			row(t("settings.version"), versionValue);
		},
		footer: t("settings.footer"),
	});
}

export function openThemeSelector({ themes = [], current, onPick }) {
	const list = themes.length
		? themes
		: [
				{ name: "dark" },
				{ name: "light" },
			];
	openModal({
		title: t("modal.selectTheme"),
		width: "narrow",
		items: list.map((th) => ({
			label: current === th.name ? `● ${th.name}` : th.name,
			sub: th.builtin ? t("modal.builtin") : t("settings.custom"),
			data: th.name,
		})),
		onSelect: (item) => {
			onPick(item.data);
			return false;
		},
	});
}

export function openThinkingSelector({ levels, current, onPick }) {
	openModal({
		title: t("modal.thinkingLevel"),
		width: "narrow",
		items: levels.map((l) => ({
			label: current === l ? `● ${l}` : l,
			data: l,
		})),
		onSelect: (item) => {
			onPick(item.data);
			return false;
		},
	});
} 

export function openScopedModelsSelector({ models, current = [], onSave }) {
	// toggle list: only models with active auth are shown; the checkmark marks
	// which are currently in the scope. Enter toggles a model; Ctrl+S saves
	// the checked set as "provider/id" patterns. A scoped model that lost auth
	// stays in `checked` (the scope) but is hidden from the list.
	const currentKeys = new Set(current.map((m) => `${m.provider}/${m.id}`));
	let checked = new Set(currentKeys);
	const available = (models ?? []).filter((m) => m.available);

	const open = () => {
		const items = available.map((m) => {
			const key = `${m.provider}/${m.id}`;
			const on = checked.has(key);
			return {
				label: on ? `✓ ${m.name}` : m.name,
				sub: `${m.provider}/${m.id}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}`,
				mark: "",
				data: m,
			};
		});
		openModal({
			title: t("modal.scopedModelsTitle", { n: checked.size }),
			searchable: true,
			items,
			footer: t("modal.scopedFooter"),
			onKey: (e) => {
				if (e.ctrlKey && (e.key === "s" || e.key === "S")) {
					e.preventDefault();
					const patterns = [...checked];
					onSave(patterns);
					closeTop();
					return true;
				}
			},
			onSelect: (item) => {
				const key = `${item.data.provider}/${item.data.id}`;
				if (checked.has(key)) checked.delete(key);
				else checked.add(key);
				open(); // re-render with updated checkmarks
				return false;
			},
		});
	};
	open();
}

/**
 * Browse + manage extensions or skills (enabled AND disabled).
 *
 * Enter toggles enable/disable (onToggle re-fetches and re-renders); Ctrl+O
 * reveals the file in the file manager; Ctrl+C copies its path; Ctrl+R
 * re-scans disk and re-loads the session. `data` is the `resources.list`
 * payload; onToggle/onReload return a fresh payload to re-render with.
 */
export function openResourceModal({ kind, data, onToggle, onReveal, onCopy, onReload, onLocked }) {
	const scopeLabel = (scope) =>
		scope === "project" ? t("modal.resourcesScopeProject") : scope === "local" || scope === "path" ? t("modal.resourcesScopeLocal") : t("modal.resourcesScopeUser");
	const resPath = (item) => item.filePath ?? item.path;
	const srcBadge = (src) => (src && src.startsWith("npm") ? "npm" : src && src.startsWith("git") ? "git" : "");

	const open = (current) => {
		const list = current[kind] ?? [];
		const enabledCount = list.filter((x) => x.enabled).length;
		const items = list.length
			? list.map((item) => {
					const parts = [];
					if (item.description) parts.push(item.description);
					if (item.author) parts.push(t("modal.resourcesBy", { name: item.author }));
					const badge = srcBadge(item.source);
					if (badge) parts.push(badge);
					parts.push(scopeLabel(item.scope));
					if (!item.enabled) parts.push(t("modal.resourcesDisabled"));
					return {
						label: item.name,
						meta: [item.version ? `v${item.version}` : "", item.toggleable ? "" : t("modal.resourcesPackage")].filter(Boolean).join("  "),
						sub: parts.join("  ·  "),
						cls: item.enabled ? "" : "mi-dim",
						checked: item.enabled,
						mark: item.enabled ? "" : "✕",
						data: item,
					};
				})
			: [{ label: t("modal.resourcesEmpty"), sub: "", disabled: true, checked: false, data: null }];

		openModal({
			title: t("modal.resourcesTitle", { kind: t(`modal.resourcesKind.${kind}`), enabled: enabledCount, total: list.length }),
			searchable: true,
			items,
			stacked: true,
			footer: t("modal.resourcesFooter"),
			onSelect: (item) => {
				if (!item.data) return;
				if (!item.data.toggleable) {
					onLocked?.(item.data);
					return false; // package resource: managed via /packages, not toggleable here
				}
				void (async () => {
					const fresh = await onToggle(item.data);
					if (fresh) open(fresh);
				})();
				return false; // stay open; re-rendered with fresh data once onToggle resolves
			},
			onKey: (e, ctx) => {
				const item = ctx?.selected?.data;
				if (e.ctrlKey && (e.key === "r" || e.key === "R")) {
					e.preventDefault();
					void (async () => {
						const fresh = await onReload();
						if (fresh) open(fresh);
					})();
					return true;
				}
				if (e.ctrlKey && (e.key === "o" || e.key === "O")) {
					e.preventDefault();
					if (item) onReveal?.(item);
					return true;
				}
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
					e.preventDefault();
					if (item) onCopy?.(item, resPath(item));
					return true;
				}
			},
		});
	};

	open(data);
}

export function openLoginSelector({ providers, authStatus, onLogin, onApiKey, onLogout }) {
	// models.authStatus may carry either the SDK AuthStatus object
	// ({configured, source?, label?}) or a plain fallback string
	const statusText = (st) => {
		if (st == null) return "?";
		if (typeof st === "string") return st;
		if (!st.configured) return t("auth.statusNotConfigured");
		return st.label ?? st.source ?? t("auth.statusConfigured");
	};
	const statusById = new Map(authStatus?.providers.map((p) => [p.id, p.status]));
	const items = providers.map((p) => ({
		label: p.name,
		sub: `${p.id} · ${p.auth.join(" / ") || t("modal.noAuthMethod")} · ${t("modal.statusLabel", { value: statusText(statusById.get(p.id)) })}`,
		data: p,
	}));
	openModal({
		title: t("modal.providerLogin"),
		searchable: true,
		items,
		footer: t("modal.loginFooter"),
		onSelect: async (item) => {
			const methods = item.data.auth.length
				? item.data.auth
				: ["api_key"];
			const method = await new Promise((resolve) => {
				openModal({
					title: t("modal.chooseMethod", { name: item.data.name }),
					width: "narrow",
					items: methods.map((m) => ({ label: m, sub: m === "oauth" ? t("modal.oauthSub") : t("modal.apiKeySub") })),
					onSelect: (mi) => {
						resolve(mi.label);
						return false;
					},
				});
			});
			if (method === undefined) return;
			if (method === "oauth") {
				onLogin(item.data.id, "oauth");
			} else {
				const key = await openInputDialog({ title: t("modal.apiKeyTitle", { name: item.data.name }), placeholder: "sk-…" });
				if (key) onApiKey(item.data.id, key);
			}
			closeTop();
		},
	});
}

// ------------------------------------------------- custom providers (models.json)

const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations", "pi-messages"];

const FORM_INPUT_CSS = "width:100%;font-size:calc(13px * var(--fs, 1.1429));padding:6px 10px;background:var(--bg-alt);border:1px solid var(--border);color:var(--fg);border-radius:6px;box-sizing:border-box";
const FORM_BTN_CSS = "background:var(--bg-alt);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 14px;cursor:pointer";
const FORM_BTN_PRIMARY_CSS = "background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:6px;padding:6px 14px;cursor:pointer";

function providerFormRow(body, label, control) {
	const div = document.createElement("div");
	div.className = "setting-row";
	const span = document.createElement("span");
	span.textContent = label;
	span.style.minWidth = "150px";
	div.append(span, control);
	body.appendChild(div);
	return control;
}

function providerFormTextInput(value = "") {
	const el = document.createElement("input");
	el.type = "text";
	el.value = value;
	el.style.cssText = FORM_INPUT_CSS;
	return el;
}

function providerFormButton(text, primary = false) {
	const b = document.createElement("button");
	b.textContent = text;
	b.style.cssText = primary ? FORM_BTN_PRIMARY_CSS : FORM_BTN_CSS;
	return b;
}

/** List of custom providers in the global models.json + entry to add new ones. */
export function openProviderConfig({ path, providers, onSave }) {
	const entries = Object.entries(providers);
	const items = [
		{ label: t("modal.addProvider"), cls: "mi-add", data: { __new: true } },
		...entries.map(([id, p]) => ({
			label: p.name ?? id,
			sub: `${id}${p.api ? ` · ${p.api}` : ""}${p.baseUrl ? ` · ${p.baseUrl}` : ""} · ${t("modal.providerModels", { n: p.models?.length ?? 0 })}`,
			data: { id },
		})),
	];
	openModal({
		title: t("modal.providersTitle"),
		searchable: true,
		items,
		footer: path,
		onSelect: (item) => {
			openProviderEditor({ path, providers, providerId: item.data.__new ? undefined : item.data.id, onSave });
			return false;
		},
	});
}

/** Edit (or create) one provider + its model list. The provider form and the
 * model form swap in place inside a single modal, so typed values survive
 * round-trips and confirmation dialogs. */
function openProviderEditor({ path, providers, providerId, onSave }) {
	const existing = providerId && providers[providerId] ? providers[providerId] : {};
	const state = {
		id: providerId && providers[providerId] ? providerId : "",
		api: existing.api ?? "",
		baseUrl: existing.baseUrl ?? "",
		apiKey: existing.apiKey ?? "",
		headers: existing.headers ? JSON.stringify(existing.headers, null, 2) : "",
		authHeader: existing.authHeader ?? true,
		models: (existing.models ?? []).slice(),
	};
	let bodyEl;
	let footerLeftEl;
	let flashTimer;
	let view = "init"; // "init" | "provider" | "model"
	// Pull the live provider-form inputs back into state so values typed in
	// the form survive view swaps (e.g. round-trips into the model editor).
	const collectProviderForm = () => {
		const t = [...bodyEl.querySelectorAll("input[type='text']")];
		if (t.length !== 5) return;
		state.id = t[0].value;
		state.api = t[1].value;
		state.baseUrl = t[2].value;
		state.apiKey = t[3].value;
		state.headers = t[4].value;
		const chk = [...bodyEl.querySelectorAll("input[type='checkbox']")];
		state.authHeader = chk[0]?.checked ?? true;
	};
	const flash = (msg) => {
		if (!footerLeftEl) return;
		footerLeftEl.textContent = msg;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (footerLeftEl.textContent = ""), 4000);
	};
	const backTo = (nextProviders) => openProviderConfig({ path, providers: nextProviders, onSave });

	const renderProviderView = () => {
		if (view === "provider") collectProviderForm();
		view = "provider";
		bodyEl.innerHTML = "";
		const idInput = providerFormRow(bodyEl, t("modal.fieldProviderId"), providerFormTextInput(state.id));
		const apiInput = providerFormRow(bodyEl, t("modal.fieldApi"), providerFormTextInput(state.api));
		const apiList = document.createElement("datalist");
		apiList.id = "provider-apis";
		for (const a of PROVIDER_APIS) {
			const o = document.createElement("option");
			o.value = a;
			apiList.appendChild(o);
		}
		apiInput.setAttribute("list", "provider-apis");
		bodyEl.appendChild(apiList);
		const baseUrlInput = providerFormRow(bodyEl, t("modal.fieldBaseUrl"), providerFormTextInput(state.baseUrl));
		const apiKeyInput = providerFormRow(bodyEl, t("modal.fieldApiKey"), providerFormTextInput(state.apiKey));
		const headersInput = providerFormRow(bodyEl, t("modal.fieldHeaders"), providerFormTextInput(state.headers));
		headersInput.placeholder = "{}";
		const authRow = document.createElement("div");
		authRow.className = "setting-row";
		const authLabel = document.createElement("span");
		authLabel.textContent = t("modal.fieldAuthHeader");
		authLabel.style.minWidth = "150px";
		const authChk = document.createElement("input");
		authChk.type = "checkbox";
		authChk.checked = state.authHeader;
		authRow.append(authLabel, authChk);
		bodyEl.appendChild(authRow);

		const sec = document.createElement("div");
		sec.className = "section-title";
		sec.textContent = t("modal.modelsSection");
		bodyEl.appendChild(sec);
		const modelsEl = document.createElement("div");
		modelsEl.style.display = "flex";
		modelsEl.style.flexDirection = "column";
		modelsEl.style.gap = "6px";
		bodyEl.appendChild(modelsEl);

		for (const m of state.models) {
			const row = document.createElement("div");
			row.className = "setting-row";
			const label = document.createElement("span");
			label.textContent = `${m.id}${m.name ? ` · ${m.name}` : ""}${m.contextWindow ? ` · ${formatTokens(m.contextWindow)} ctx` : ""}`;
			row.appendChild(label);
			const editBtn = providerFormButton(t("modal.edit"));
			editBtn.addEventListener("click", () => renderModelView(m));
			const delBtn = providerFormButton("✕");
			delBtn.title = t("modal.deleteModel");
			delBtn.addEventListener("click", async () => {
				const ok = await openConfirmDialog({ title: t("modal.deleteModel"), message: t("modal.deleteModelQ", { id: m.id }) });
				if (ok) state.models = state.models.filter((x) => x.id !== m.id);
				show(); // the confirm dialog closed this modal; re-open the editor
			});
			row.append(editBtn, delBtn);
			modelsEl.appendChild(row);
		}
		const addModelBtn = providerFormButton(t("modal.addModel"));
		addModelBtn.style.alignSelf = "flex-start";
		addModelBtn.addEventListener("click", () => renderModelView(undefined));
		modelsEl.appendChild(addModelBtn);

		const btns = document.createElement("div");
		btns.style.display = "flex";
		btns.style.gap = "8px";
		btns.style.justifyContent = "flex-end";
		btns.style.marginTop = "12px";
		if (state.id) {
			const delProviderBtn = providerFormButton(t("modal.deleteProvider"));
			delProviderBtn.style.marginRight = "auto";
			delProviderBtn.addEventListener("click", async () => {
				const ok = await openConfirmDialog({ title: t("modal.deleteProvider"), message: t("modal.deleteProviderQ", { id: state.id }) });
				if (!ok) {
					show();
					return;
				}
				const next = removeProvider(providers, state.id);
				if ((await onSave(next)) !== false) backTo(next);
				else show();
			});
			btns.appendChild(delProviderBtn);
		}
		const backBtn = providerFormButton(t("modal.back"));
		backBtn.addEventListener("click", () => backTo(providers));
		const saveBtn = providerFormButton(t("modal.save"), true);
		saveBtn.addEventListener("click", async () => {
			const id = idInput.value.trim();
			if (!id) return flash(t("modal.idRequired"));
			let headers;
			const hRaw = headersInput.value.trim();
			if (hRaw) {
				try {
					headers = JSON.parse(hRaw);
					if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("not an object");
				} catch {
					return flash(t("modal.headersInvalid"));
				}
			} else {
				headers = undefined;
			}
			const draft = {
				api: apiInput.value.trim() || undefined,
				baseUrl: baseUrlInput.value.trim() || undefined,
				apiKey: apiKeyInput.value.trim() || undefined,
				headers,
				authHeader: authChk.checked,
				models: state.models,
			};
			let next;
			if (state.id && state.id !== id) {
				if (providers[id] !== undefined) return flash(t("modal.idTaken", { id }));
				next = upsertProvider(removeProvider(providers, state.id), id, draft);
			} else {
				next = upsertProvider(providers, id, draft);
			}
			if ((await onSave(next)) !== false) backTo(next);
		});
		btns.append(backBtn, saveBtn);
		bodyEl.appendChild(btns);
	};

	const renderModelView = (model) => {
		if (view === "provider") collectProviderForm();
		view = "model";
		bodyEl.innerHTML = "";
		const idInput = providerFormRow(bodyEl, t("modal.fieldModelId"), providerFormTextInput(model?.id ?? ""));
		const nameInput = providerFormRow(bodyEl, t("modal.fieldName"), providerFormTextInput(model?.name ?? ""));
		const ctxInput = providerFormRow(bodyEl, t("modal.fieldContextWindow"), providerFormTextInput(String(model?.contextWindow ?? "")));
		const maxInput = providerFormRow(bodyEl, t("modal.fieldMaxTokens"), providerFormTextInput(String(model?.maxTokens ?? "")));
		const costInInput = providerFormRow(bodyEl, t("modal.fieldCostInput"), providerFormTextInput(String(model?.cost?.input ?? "")));
		const costOutInput = providerFormRow(bodyEl, t("modal.fieldCostOutput"), providerFormTextInput(String(model?.cost?.output ?? "")));

		const flagRow = (label, initial) => {
			const row = document.createElement("div");
			row.className = "setting-row";
			const span = document.createElement("span");
			span.textContent = label;
			span.style.minWidth = "150px";
			const chk = document.createElement("input");
			chk.type = "checkbox";
			chk.checked = initial;
			row.append(span, chk);
			bodyEl.appendChild(row);
			return chk;
		};
		const reasoningChk = flagRow(t("modal.fieldReasoning"), model?.reasoning ?? false);
		const inputTypesRow = document.createElement("div");
		inputTypesRow.className = "setting-row";
		const itLabel = document.createElement("span");
		itLabel.textContent = t("modal.fieldInputTypes");
		itLabel.style.minWidth = "150px";
		const mkChk = (label, checked) => {
			const wrap = document.createElement("label");
			wrap.style.cssText = "display:inline-flex;align-items:center;gap:5px;margin-right:14px;cursor:pointer;";
			const chk = document.createElement("input");
			chk.type = "checkbox";
			chk.checked = checked;
			wrap.append(chk, document.createTextNode(label));
			return wrap;
		};
		const textChk = mkChk("text", !model || (model.input ?? ["text"]).includes("text"));
		const imageChk = mkChk("image", !!model?.input?.includes("image"));
		inputTypesRow.append(itLabel, textChk, imageChk);
		bodyEl.appendChild(inputTypesRow);

		const num = (v) => {
			const s = v.trim();
			if (!s) return undefined;
			const n = Number(s);
			return Number.isFinite(n) && n > 0 ? n : undefined;
		};
		const btns = document.createElement("div");
		btns.style.display = "flex";
		btns.style.gap = "8px";
		btns.style.justifyContent = "flex-end";
		btns.style.marginTop = "12px";
		const cancelBtn = providerFormButton(t("modal.back"));
		cancelBtn.addEventListener("click", () => renderProviderView());
		const saveBtn = providerFormButton(t("modal.save"), true);
		saveBtn.addEventListener("click", () => {
			const id = idInput.value.trim();
			if (!id) return flash(t("modal.idRequired"));
			const inputs = [];
			if (textChk.querySelector("input").checked) inputs.push("text");
			if (imageChk.querySelector("input").checked) inputs.push("image");
			if (inputs.length === 0) return flash(t("modal.inputNone"));
			const costBad = (v) => {
				const s = v.trim();
				return s !== "" && !(Number.isFinite(Number(s)) && Number(s) >= 0);
			};
			if (costBad(costInInput.value) || costBad(costOutInput.value)) return flash(t("modal.costInvalid"));
			const draft = {
				id,
				name: nameInput.value.trim() || undefined,
				contextWindow: num(ctxInput.value),
				maxTokens: num(maxInput.value),
				reasoning: reasoningChk.checked || undefined,
				input: inputs,
				cost: updateCostFields(model?.cost, costInInput.value, costOutInput.value),
			};
			const i = state.models.findIndex((x) => x.id === id);
			if (i >= 0) state.models[i] = { ...state.models[i], ...stripUndefined(draft) };
			else state.models.push(draft);
			renderProviderView();
		});
		btns.append(cancelBtn, saveBtn);
		bodyEl.appendChild(btns);
	};

	const show = () => {
		openModal({
			title: state.id ? t("modal.providerEdit", { id: state.id }) : t("modal.providerNew"),
			width: "wide",
			footer: path,
			renderBody: (body, { footerEl }) => {
				bodyEl = body;
				footerLeftEl = footerEl.querySelector(".mf-left");
				renderProviderView();
			},
		});
	};
	show();
}

export function openHotkeysModal({ bindings, platform }) {
	openModal({
		title: t("modal.keyboardShortcuts"),
		width: "wide",
		renderBody: (body) => {
			const groups = new Map();
			for (const [action, combos] of Object.entries(bindings)) {
				const [group] = action.split(".");
				if (!groups.has(group)) groups.set(group, []);
				groups.get(group).push([action, Array.isArray(combos) ? combos : [combos]]);
			}
			for (const [group, entries] of groups) {
				const title = document.createElement("div");
				title.className = "section-title";
				title.textContent = group;
				body.appendChild(title);
				for (const [action, combos] of entries) {
					const row = document.createElement("div");
					row.className = "setting-row";
					row.innerHTML = `<span>${escapeHtml(action)}</span><span>${combos
						.map((c) => `<b style="font-weight:600">${escapeHtml(comboLabel(c, platform))}</b>`)
						.join(" / ")}</span>`;
					body.appendChild(row);
				}
			}
		},
		footer: t("modal.escClose"),
	});
}

export function openHelpModal({ commands, skills = [], extensions = [] }) {
	const items = [
		...commands.map((c) => ({ label: c.name, sub: tCmd(c.name, c.description), data: c })),
		...extensions.map((c) => ({ label: `/${c.name}`, sub: t("cmd.extensionPrefix", { desc: c.description ?? "" }), data: c })),
		...skills.map((s) => ({ label: `/${s.name}`, sub: t("cmd.skillPrefix", { desc: s.description ?? "" }), data: s })),
	];
	openModal({
		title: t("modal.commandsTitle"),
		searchable: true,
		items,
		footer: t("modal.helpFooter"),
	});
}

export function openSessionInfoModal({ info }) {
	openModal({
		title: t("modal.sessionInfo"),
		width: "narrow",
		renderBody: (body) => {
			const stats = info.stats ?? {};
			body.innerHTML = `
				<div class="setting-row"><span>${t("info.sessionId")}</span><span>${escapeHtml(info.sessionId ?? "")}</span></div>
				<div class="setting-row"><span>${t("info.name")}</span><span>${escapeHtml(info.sessionName ?? t("info.unnamed"))}</span></div>
				<div class="setting-row"><span>${t("info.file")}</span><span style="word-break:break-all">${escapeHtml(info.sessionFile ?? "")}</span></div>
				<div class="setting-row"><span>${t("info.cwd")}</span><span style="word-break:break-all">${escapeHtml(info.cwd ?? "")}</span></div>
				<div class="setting-row"><span>${t("info.messages")}</span><span>${stats.messageCount ?? info.messages?.length ?? 0}</span></div>
				<div class="setting-row"><span>${t("info.tokens")}</span><span>${formatTokens(stats.totalTokens ?? 0)}</span></div>
				<div class="setting-row"><span>${t("info.cost")}</span><span>$${(stats.totalCost ?? 0).toFixed(4)}</span></div>
				<div class="setting-row"><span>${t("info.gitBranch")}</span><span>${escapeHtml(info.gitBranch ?? "—")}</span></div>`;
		},
		footer: t("modal.escClose"),
	});
}

export function openDebugModal({ systemPrompt, resources, diagnostics, stats }) {
	openModal({
		title: t("modal.debugTitle"),
		width: "wide",
		renderBody: (body) => {
			const pre = (text, label) => {
				if (!text) return;
				const t = document.createElement("div");
				t.className = "section-title";
				t.textContent = label;
				body.appendChild(t);
				const p = document.createElement("pre");
				p.textContent = text;
				p.style.maxHeight = "180px";
				body.appendChild(p);
			};
			pre(systemPrompt, t("debug.systemPrompt"));
			pre(
				`${t("debug.extensions")}: ${(resources.extensions ?? []).map((e) => e.name).join(", ") || t("debug.none")}\n` +
					`${t("debug.extensionErrors")}: ${(resources.extensionErrors ?? []).map((e) => `${e.path}: ${e.error}`).join("\n") || t("debug.none")}\n` +
					`${t("debug.skills")}: ${(resources.skills ?? []).map((s) => s.name).join(", ") || t("debug.none")}\n` +
					`${t("debug.prompts")}: ${(resources.prompts ?? []).map((p) => p.name).join(", ") || t("debug.none")}\n` +
					`${t("debug.contextFiles")}: ${(resources.contextFiles ?? []).map((f) => f.path).join("\n") || t("debug.none")}`,
				t("debug.loadedResources"),
			);
			pre((diagnostics ?? []).map((d) => `[${d.type}] ${d.message}`).join("\n"), t("debug.diagnostics"));
			pre(JSON.stringify(stats ?? {}, null, 2), t("debug.stats"));
		},
		footer: t("modal.escClose"),
	});
}

export function openForkSelector({ userMessages, onFork, onClone }) {
	const items = userMessages.map((m, i) => ({
		label: (m.text ?? "").replace(/\n/g, " ").slice(0, 90) || t("modal.emptyMessage"),
		sub: `#${i + 1} · ${m.entryId.slice(0, 8)}`,
		data: m,
	}));
	openModal({
		title: t("modal.forkTitle"),
		searchable: true,
		items,
		onSelect: (item) => {
			onFork(item.data.entryId, "before");
			return false;
		},
		onKey: (e, ctx) => {
			const entryId = ctx?.selected?.data.entryId;
			if (!entryId) return;
			if (e.ctrlKey && e.key === "Enter") {
				e.preventDefault();
				onFork(entryId, "before");
				return true;
			}
			if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
				e.preventDefault();
				onClone(entryId, "at");
				return true;
			}
		},
	});
}

export function openTrustModal({ trusted, onToggle }) {
	openModal({
		title: t("modal.projectTrust"),
		width: "narrow",
		items: [
			{
				label: trusted ? t("modal.trusted") : t("modal.untrusted"),
				sub: t("modal.trustSub"),
				disabled: true, // status row, not an action
			},
			{ label: t("modal.toggleTrust"), sub: t("modal.toggleTrustSub"), data: "toggle" },
		],
		onSelect: (item) => {
			if (item.data === "toggle") {
				onToggle(!trusted);
				return false;
			}
		},
	});
}

export function openChangelogModal({ text }) {
	openModal({
		title: t("modal.changelog"),
		width: "wide",
		renderBody: (body) => {
			const pre = document.createElement("pre");
			pre.textContent = text ?? t("modal.changelogMissing");
			pre.style.maxHeight = "55vh";
			body.appendChild(pre);
		},
		footer: t("modal.escClose"),
	});
}

export { openModal as openModalPublic };

export function openEasterEgg({ kind }) {
	const art =
		kind === "armin"
			? String.raw`
     ___
    / _ \     Armin says: hi from Pi Desktop!
   | |_| |   (this is the /arminsayshi easter egg)
   |  _  |
  |_| |_|\
`
			: String.raw`
   _   _
  | | | |   The demented elves are crafting your
  | |_| |   code. /dementedelves
  |  _  |
  |_| |_|
`;
	openModal({
		title: kind === "armin" ? "Armin" : "Demented elves",
		width: "narrow",
		renderBody: (body) => {
			const pre = document.createElement("pre");
			pre.textContent = art;
			body.appendChild(pre);
		},
		footer: t("modal.escClose"),
	});
}
