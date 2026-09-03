import { completionContext, isBashCommand, extractBashCommand, BUILTIN_COMMANDS } from "../../shared/slash.js";
import { t, tCmd } from "../../shared/i18n.js";

/**
 * Input editor: multiline textarea with history, autocomplete (/ commands,
 * prompt templates, skills, @files), bash mode (!), and image attachments.
 */
export class Editor {
	#el;
	#attachTray;
	#acEl;
	#history = [];
	#historyIndex = -1; // -1 = not browsing
	#attachments = [];
	#acItems = [];
	#acSelected = 0;
	#acVisible = false;
	#acRequestId = 0; // guards against stale async completion responses
	#onSubmit;
	#onFollowUp;
	#onBash;
	#commands = BUILTIN_COMMANDS;
	#skills = [];
	#prompts = [];

	constructor({ el, attachTray, autocomplete, onSubmit, onFollowUp, onBash }) {
		this.#el = el;
		this.#attachTray = attachTray;
		this.#acEl = autocomplete;
		this.#onSubmit = onSubmit;
		this.#onFollowUp = onFollowUp;
		this.#onBash = onBash;

		el.addEventListener("keydown", (e) => this.#onKeydown(e));
		el.addEventListener("input", () => {
			this.#autoGrow();
			this.#updateBashMode();
			this.#updateCompletion();
		});
		el.addEventListener("paste", (e) => {
			const items = e.clipboardData?.items ?? [];
			const imageItems = [...items].filter((i) => i.type.startsWith("image/"));
			if (imageItems.length > 0) {
				e.preventDefault();
				for (const item of imageItems) {
					const file = item.getAsFile();
					if (file) this.attachFile(file);
				}
			}
		});
		el.addEventListener("focus", () => {});
	}

	focus() {
		this.#el.focus();
	}

	getText() {
		return this.#el.value;
	}

	setText(text) {
		this.#el.value = text;
		this.#autoGrow();
		this.#updateBashMode();
	}

	get attachments() {
		return this.#attachments.slice();
	}

	clearAttachments() {
		this.#attachments = [];
		this.#renderAttachTray();
	}

	clear() {
		this.setText("");
		this.clearAttachments();
		this.hideCompletion();
	}

	setCommands(commands, skills = [], prompts = []) {
		this.#commands = commands;
		this.#skills = skills;
		this.#prompts = prompts;
	}

	async attachFile(file) {
		try {
			const reader = new FileReader();
			const data = await new Promise((res) => {
				reader.onload = () => res(reader.result);
				reader.readAsDataURL(file);
			});
			const [meta, b64] = String(data).split(",");
			const mime = meta.match(/data:([^;]+)/)?.[1] ?? "image/png";
			this.#attachments.push({
				name: file.name ?? "pasted-image",
				mime,
				data: b64,
			});
			this.#renderAttachTray();
		} catch (error) {
			console.error("attach failed", error);
		}
	}

	async pasteClipboardImage() {
		const img = await window.pi.invoke("system.clipboard.readImage");
		if (!img) return false;
		this.attachImage({ name: "clipboard-image", mime: img.mime, data: img.data });
		return true;
	}

	attachImage({ name, mime, data }) {
		this.#attachments.push({ name, mime, data });
		this.#renderAttachTray();
	}

	#renderAttachTray() {
		const tray = this.#attachTray;
		tray.innerHTML = "";
		tray.hidden = this.#attachments.length === 0;
		this.#attachments.forEach((a, i) => {
			const chip = document.createElement("div");
			chip.className = "attach-chip";
			const img = document.createElement("img");
			img.src = `data:${a.mime};base64,${a.data}`;
			const span = document.createElement("span");
			span.textContent = a.name;
			const btn = document.createElement("button");
			btn.textContent = "✕";
			btn.addEventListener("click", () => {
				this.#attachments.splice(i, 1);
				this.#renderAttachTray();
			});
			chip.append(img, span, btn);
			tray.appendChild(chip);
		});
	}

	#autoGrow() {
		const el = this.#el;
		el.style.height = "auto";
		el.style.height = Math.min(el.scrollHeight, 240) + "px";
	}

	#updateBashMode() {
		this.#el.classList.toggle("bash-mode", isBashCommand(this.#el.value));
	}

	// ------------------------------------------------------------ keydown

	#onKeydown(e) {
		const el = this.#el;
		const value = el.value;

		// autocomplete navigation
		if (this.#acVisible) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.#acSelected = (this.#acSelected + 1) % this.#acItems.length;
				this.#renderCompletion();
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.#acSelected = (this.#acSelected - 1 + this.#acItems.length) % this.#acItems.length;
				this.#renderCompletion();
				return;
			}
			if (e.key === "Tab" || e.key === "Enter") {
				e.preventDefault();
				if (e.key === "Enter" && this.#acItems.length > 1) {
					// complete but keep typing when several options
					this.#applyCompletion();
					return;
				}
				this.#applyCompletion();
				if (e.key === "Enter") {
					// fall through to submit after completing
					this.#submit(e);
					return;
				}
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.hideCompletion();
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.#submit(e);
			return;
		}
		if ((e.altKey && e.key === "Enter") || (e.ctrlKey && (e.key === "q" || e.key === "Q"))) {
			e.preventDefault();
			this.#submitFollowUp();
			return;
		}
		// history
		if (e.key === "ArrowUp" && !e.shiftKey && this.#el.selectionStart === 0 && value.split("\n").length === 1) {
			e.preventDefault();
			this.#historyMove(-1);
			return;
		}
		if (e.key === "ArrowDown" && !e.shiftKey && this.#el.selectionEnd === value.length && value.split("\n").length === 1) {
			e.preventDefault();
			this.#historyMove(1);
			return;
		}
	}

	#historyMove(dir) {
		if (dir < 0) {
			if (this.#historyIndex === -1) {
				this.#historyIndex = this.#history.length;
			}
			this.#historyIndex = Math.max(0, this.#historyIndex - 1);
		} else {
			if (this.#historyIndex === -1) return;
			this.#historyIndex = Math.min(this.#history.length, this.#historyIndex + 1);
		}
		if (this.#historyIndex === this.#history.length) {
			this.#historyIndex = -1;
			this.setText("");
		} else {
			this.setText(this.#history[this.#historyIndex]);
		}
	}

	#submitFollowUp() {
		const text = this.#el.value.trim();
		if (!text && this.#attachments.length === 0) return;
		const images = this.#attachments.map((a) => ({
			type: "image",
			data: a.data, // SDK ImageContent: base64 + mimeType
			mimeType: a.mime,
		}));
		this.#el.value = "";
		this.clearAttachments();
		this.#autoGrow();
		this.#onFollowUp?.(text, images);
	}

	#submit(e) {
		const raw = this.#el.value;
		const text = raw.trim();
		const images = this.#attachments.map((a) => ({
			type: "image",
			data: a.data, // SDK ImageContent: base64 + mimeType
			mimeType: a.mime,
		}));
		if (!text && images.length === 0) return;

		// bash mode
		if (isBashCommand(text)) {
			this.clear();
			this.#pushHistory(text);
			const { command, excluded } = extractBashCommand(text);
			if (command) this.#onBash?.(command, excluded);
			return;
		}

		this.clear();
		this.#pushHistory(text);
		this.#onSubmit(text, images, e);
	}

	#pushHistory(text) {
		const last = this.#history[this.#history.length - 1];
		if (last !== text) {
			this.#history.push(text);
			if (this.#history.length > 200) this.#history.shift();
		}
		this.#historyIndex = -1;
	}

	// ------------------------------------------------------------ completion

	async #updateCompletion() {
		const reqId = ++this.#acRequestId;
		const value = this.#el.value;
		const ctx = completionContext(value, this.#el.selectionStart);
		if (!ctx) {
			this.hideCompletion();
			return;
		}
		if (ctx.kind === "slash") {
			const all = [
				...this.#commands.map((c) => ({ name: c.name, description: tCmd(c.name, c.description) })),
				...this.#prompts.map((p) => ({ name: `/${p.name}`, description: p.description ?? p.source })),
				...this.#skills.map((s) => ({ name: `/${s.name}`, description: t("cmd.skillPrefix", { desc: s.description ?? "" }) })),
			];
			const matches = all.filter((c) => c.name.toLowerCase().startsWith(ctx.token.toLowerCase())).slice(0, 12);
			this.#acItems = matches.map((c) => ({ label: c.name, sub: c.description ?? "", insert: c.name + " " }));
		} else {
			const files = await window.pi.invoke("system.fs.list", { prefix: ctx.token.slice(1) });
			// a newer input event (or hideCompletion) superseded this request
			if (reqId !== this.#acRequestId) return;
			this.#acItems = (files ?? []).map((f) => ({ label: f, sub: t("tr.file"), insert: f }));
		}
		if (this.#acItems.length === 0) {
			this.hideCompletion();
			return;
		}
		this.#acSelected = 0;
		this.#acVisible = true;
		this.#renderCompletion();
	}

	#renderCompletion() {
		const el = this.#acEl;
		el.hidden = false;
		el.innerHTML = "";
		this.#acItems.forEach((item, i) => {
			const div = document.createElement("div");
			div.className = "ac-item" + (i === this.#acSelected ? " selected" : "");
			div.innerHTML = `<span class="ac-name"></span><span class="ac-desc"></span>`;
			div.querySelector(".ac-name").textContent = item.label;
			div.querySelector(".ac-desc").textContent = item.sub;
			div.addEventListener("click", () => {
				this.#acSelected = i;
				this.#applyCompletion();
			});
			el.appendChild(div);
		});
	}

	#applyCompletion() {
		const item = this.#acItems[this.#acSelected];
		if (!item) return;
		const el = this.#el;
		const value = el.value;
		const ctx = completionContext(value, el.selectionStart);
		if (!ctx) return;
		const before = value.slice(0, el.selectionStart - ctx.token.length);
		const after = value.slice(el.selectionStart);
		el.value = before + item.insert + after;
		const caret = (before + item.insert).length;
		el.setSelectionRange(caret, caret);
		this.hideCompletion();
		this.#autoGrow();
		el.focus();
	}

	hideCompletion() {
		this.#acVisible = false;
		this.#acItems = [];
		this.#acEl.hidden = true;
		this.#acRequestId++; // invalidate in-flight file-list requests
	}
}
