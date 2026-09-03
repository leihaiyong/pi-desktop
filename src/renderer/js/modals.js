import { escapeHtml } from "./markdown.js";
import { formatTimestamp, formatTokens } from "../../shared/format.js";
import { flattenTree } from "../../shared/tree.js";
import { comboLabel } from "../../shared/keys.js";
import { t, tCmd, SUPPORTED_LANGUAGES } from "../../shared/i18n.js";

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
			row.className = "modal-item" + (i === selected ? " selected" : "");
			row.innerHTML = `<span class="mi-main"></span><span class="mi-sub"></span><span class="mi-check"></span>`;
			row.querySelector(".mi-main").textContent = it.label;
			row.querySelector(".mi-sub").textContent = it.sub ?? "";
			row.querySelector(".mi-check").textContent = it.checked ? "✓" : it.mark ?? "";
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
						button class="btn-cancel" style="background:var(--bg-alt);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:6px 14px;cursor:pointer">${escapeHtml(t("modal.cancel"))}</button>
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
	const byProvider = new Map();
	for (const m of models) {
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
			onPick(item.data);
			return false;
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

export function openTreeSelector({ tree, onNavigate, onFork, onClone, onLabel, filter = "default" }) {
	const rows = flattenTree(tree.entries, tree.leafId);
	const visibleRows = rows.filter((row) => {
		switch (filter) {
			case "user-only":
				return row.role === "user";
			case "no-tools":
				return !["toolResult", "model", "thinking", "label", "custom", "session", "message"].includes(row.type) || row.role === "user" || row.role === "assistant" || row.role === "compaction" || row.role === "branchSummary";
			case "labeled-only":
				return row.label != null;
			case "all":
				return true;
			default:
				return !["model", "thinking", "session", "label", "custom"].includes(row.type);
		}
	});
	openModal({
		title: t("modal.sessionTreeTitle"),
		width: "wide",
		searchable: false,
		renderBody: (body, { close }) => {
			body.innerHTML = "";
			let selected = visibleRows.findIndex((r) => r.isLeaf);
			if (selected < 0) selected = visibleRows.length - 1;
			const listEl = document.createElement("div");
			listEl.style.overflowY = "auto";
			listEl.style.maxHeight = "50vh";
			body.appendChild(listEl);

			function render() {
				listEl.innerHTML = "";
				visibleRows.forEach((row, i) => {
					const div = document.createElement("div");
					div.className = "tree-row" + (i === selected ? " selected" : "") + (row.isLeaf ? " leaf" : "");
					const indent = "&nbsp;".repeat(row.depth * 2 + 1);
					div.innerHTML = `<span class="t-depth">${indent}${row.isLeaf ? "▶ " : ""}</span><span class="t-role">${escapeHtml(row.role ?? row.type)}</span><span class="t-label">${
						row.label ? `[${escapeHtml(row.label)}] ` : ""
					}</span><span class="t-text"></span><span class="t-time">${row.timestamp ? formatTimestamp(row.timestamp).slice(5) : ""}</span>`;
					div.querySelector(".t-text").textContent = row.text || t("modal.noText");
					div.addEventListener("click", () => {
						selected = i;
						render();
					});
					listEl.appendChild(div);
				});
			}
			render();

			async function act(kind) {
				const row = visibleRows[selected];
				if (!row) return;
				if (kind === "navigate") onNavigate(row);
				if (kind === "fork") onFork?.(row);
				if (kind === "clone") onClone?.(row);
				if (kind === "label") {
					const label = await openInputDialog({ title: t("modal.setLabel"), initial: row.label ?? "" });
					if (label !== undefined) onLabel(row, label);
				}
			}

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
				if (e.key === "Enter") {
					e.preventDefault();
					act("navigate");
					return true;
				}
				if (e.ctrlKey && e.key === "Enter") {
					e.preventDefault();
					act("fork");
					return true;
				}
				if (e.shiftKey && (e.key === "l" || e.key === "L")) {
					e.preventDefault();
					act("label");
					return true;
				}
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
					e.preventDefault();
					act("clone");
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
	// toggle list: every known model, checked when currently in the scope.
	// Enter toggles a model (reopening the modal with the updated state);
	// Ctrl+S saves the checked set as "provider/id" patterns.
	const currentKeys = new Set(current.map((m) => `${m.provider}/${m.id}`));
	let checked = new Set(currentKeys);

	const open = () => {
		const items = models.map((m) => ({
			label: m.name,
			sub: `${m.provider}/${m.id}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}`,
			checked: checked.has(`${m.provider}/${m.id}`),
			mark: checked.has(`${m.provider}/${m.id}`) ? "✓" : "",
			data: m,
		}));
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

export function openLoginSelector({ providers, authStatus, onLogin, onApiKey, onLogout }) {
	const statusById = new Map(authStatus?.providers.map((p) => [p.id, p.status]));
	const items = providers.map((p) => ({
		label: p.name,
		sub: `${p.id} · ${p.auth.join(" / ") || t("modal.noAuthMethod")} · ${t("modal.statusLabel", { value: statusById.get(p.id) ?? "?" })}`,
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

export function openHelpModal({ commands, skills = [] }) {
	const items = [
		...commands.map((c) => ({ label: c.name, sub: tCmd(c.name, c.description), data: c })),
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
