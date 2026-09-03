import { renderMarkdown, renderStreamingMarkdown, escapeHtml } from "./markdown.js";
import { renderDiffToHtml } from "../../shared/diff.js";
import { parseSkillBlock } from "./skill.js";
import { t } from "../../shared/i18n.js";

/**
 * Transcript view: renders the session message list plus live streaming state
 * into #transcript.
 */
export class Transcript {
	#root;
	#messages = [];
	#renderedFingerprints = []; // fingerprint per rendered message (synced with #messages)
	#streaming = null; // partial assistant message
	#toolStates = new Map(); // toolCallId -> {name, args, output, isError, running}
	#lastAssistantTextHtml = "";
	#lastAssistantThinking = "";
	#follow = true;
	#expandedTools = new Set();
	#thinkingCollapsed = false;
	#bashExcluded = false; // live bash block started with !! prefix (dimmed, excluded from LLM context)
	#onScrollChange;

	constructor(root, onScrollChange) {
		this.#root = root;
		this.#onScrollChange = onScrollChange;
		root.addEventListener("scroll", () => {
			const atBottom =
				root.scrollHeight - root.scrollTop - root.clientHeight < 40;
			this.#follow = atBottom;
			onScrollChange?.(atBottom);
		});
	}

	get messageCount() {
		return this.#messages.length;
	}

	setMessages(messages) {
		const next = messages ?? [];
		// Fast path: the new list extends the rendered list (the common case —
		// a settled snapshot after a completed turn). Append only the new tail
		// instead of re-rendering the whole transcript.
		const fps = this.#renderedFingerprints;
		const appendable =
			!this.#streaming &&
			next.length > fps.length &&
			next.slice(0, fps.length).every((m, i) => this.#fingerprint(m) === fps[i]);
		if (appendable) {
			this.#messages = next;
			// The live bash block is stale once its finalized bashExecution message
			// arrives (the SDK has no bash-end event; the snapshot pull finalizes it).
			if (next.slice(fps.length).some((m) => m.role === "bashExecution")) {
				this.#root.querySelector("[data-live-bash]")?.remove();
			}
			const results = this.#buildResultsMap(next);
			for (let i = fps.length; i < next.length; i++) {
				this.#appendMessageNode(next[i], results);
			}
			this.#renderedFingerprints = next.map((m) => this.#fingerprint(m));
			this.#maybeScroll();
			return;
		}
		this.#messages = next;
		this.rebuild();
	}

	/**
	 * Content-based dedupe. Event payloads and snapshot messages are separate
	 * structured clones, so object identity never matches across IPC; compare
	 * by a stable fingerprint instead. Only the tail is checked: duplicates can
	 * only occur for messages added around the last snapshot, and a whole-list
	 * content match would wrongly swallow legitimately repeated user messages.
	 */
	hasCommitted(message) {
		const fp = this.#fingerprint(message);
		const start = Math.max(0, this.#messages.length - 3);
		for (let i = start; i < this.#messages.length; i++) {
			if (this.#fingerprint(this.#messages[i]) === fp) return true;
		}
		return false;
	}

	addMessage(message) {
		if (this.hasCommitted(message)) return;
		this.#messages.push(message);
		this.#renderedFingerprints.push(this.#fingerprint(message));
		if (!this.#streaming) {
			this.#appendMessageNode(message, this.#buildResultsMap(this.#messages));
		}
		// while streaming the live block is re-rendered on the next event and
		// commitAssistant() rebuilds at the end
		this.#maybeScroll();
	}

	/**
	 * kind: "compactionSummary" | "branchSummary" (stable id, not display text)
	 */
	addSummary(summary, kind) {
		const role = kind === "branchSummary" ? "branchSummary" : "compactionSummary";
		const msg = { role, summary };
		this.#messages.push(msg);
		this.#renderedFingerprints.push(this.#fingerprint(msg));
		if (!this.#streaming) this.#appendMessageNode(msg, new Map());
		this.#maybeScroll();
	}

	#fingerprint(msg) {
		if (!msg) return "";
		if (msg.role === "toolResult") {
			return `toolResult:${msg.toolCallId ?? ""}:${this.#toolOutputText(msg).slice(0, 120)}`;
		}
		if (msg.summary !== undefined) {
			return `${msg.role}:summary:${String(msg.summary).slice(0, 120)}`;
		}
		return `${msg.role}:${msg.stopReason ?? ""}:${this.#textOf(msg).slice(0, 200)}`;
	}

	#buildResultsMap(messages) {
		const results = new Map();
		for (const msg of messages) {
			if (msg.role === "toolResult" && msg.toolCallId) results.set(msg.toolCallId, msg);
		}
		return results;
	}

	#appendMessageNode(msg, results) {
		let node = null;
		switch (msg.role) {
			case "user":
				node = this.#buildUserBlock(msg);
				break;
			case "assistant":
				node = this.#buildAssistantBlock(msg, { results });
				break;
			case "bashExecution":
				node = this.#buildBashBlock(msg);
				break;
			case "compactionSummary":
				node = this.#buildSummaryBlock(msg.summary, t("tr.compactionSummary"));
				break;
			case "branchSummary":
				node = this.#buildSummaryBlock(msg.summary, t("tr.branchSummary"));
				break;
			case "custom":
				if (msg.display !== false) node = this.#buildCustomBlock(msg);
				break;
			case "toolResult": {
				const assistantHasCall = this.#messages.some(
					(m) =>
						m.role === "assistant" &&
						Array.isArray(m.content) &&
						m.content.some((p) => p.type === "toolCall" && p.id === msg.toolCallId),
				);
				if (!assistantHasCall) node = this.#buildToolResultBlock(msg);
				break;
			}
		}
		if (!node) return;
		const live = this.#root.querySelector("[data-live],[data-live-bash]");
		if (live) this.#root.insertBefore(node, live);
		else this.#root.appendChild(node);
	}

	toggleThinkingCollapsed() {
		this.#thinkingCollapsed = !this.#thinkingCollapsed;
		this.rebuild();
	}

	get expandedAll() {
		let calls = 0;
		let expanded = 0;
		for (const msg of this.#messages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "toolCall") {
						calls++;
						if (this.#expandedTools.has(part.id)) expanded++;
					}
				}
			}
		}
		return calls > 0 && expanded >= calls;
	}

	reset() {
		this.#messages = [];
		this.#renderedFingerprints = [];
		this.#streaming = null;
		this.#toolStates.clear();
		this.rebuild();
	}

	get follow() {
		return this.#follow;
	}

	setThinkingCollapsed(collapsed) {
		this.#thinkingCollapsed = collapsed;
		this.rebuild();
	}

	scrollToEnd() {
		this.#follow = true;
		this.#root.scrollTop = this.#root.scrollHeight;
	}

	scrollToStart() {
		this.#root.scrollTop = 0;
	}

	page(delta) {
		this.#root.scrollBy({ top: delta * this.#root.clientHeight * 0.9, behavior: "smooth" });
	}

	toggleToolExpansion(toolCallId) {
		if (this.#expandedTools.has(toolCallId)) this.#expandedTools.delete(toolCallId);
		else this.#expandedTools.add(toolCallId);
		this.rebuild();
	}

	toggleAllTools(expand) {
		if (expand) {
			for (const id of this.#toolStates.keys()) this.#expandedTools.add(id);
			for (const msg of this.#messages) {
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "toolCall") this.#expandedTools.add(part.id);
					}
				}
			}
		} else {
			this.#expandedTools.clear();
		}
		this.rebuild();
	}

	// ---------------------------------------------------------------- streaming

	startAssistantStream(message) {
		this.#streaming = { message };
		this.#lastAssistantTextHtml = "";
		this.#lastAssistantThinking = "";
		this.#ensureStreamBlock();
	}

	#ensureStreamBlock() {
		// append a live block at the end
		const existing = this.#root.querySelector("[data-live]");
		if (existing) return existing;
		const el = this.#buildAssistantBlock(this.#streaming.message, { live: true });
		this.#root.appendChild(el);
		this.#maybeScroll();
		return el;
	}

	handleMessageUpdate(message, assistantMessageEvent) {
		if (!this.#streaming) this.startAssistantStream(message);
		this.#streaming.message = message;
		const ev = assistantMessageEvent;
		const el = this.#ensureStreamBlock();
		if (ev.type === "text_delta") {
			const text = this.#textOf(message);
			this.#updateStreamText(el, text, true);
		} else if (ev.type === "thinking_delta") {
			const thinking = this.#thinkingOf(message);
			this.#updateStreamThinking(el, thinking);
		} else if (ev.type === "toolcall_start" || ev.type === "toolcall_delta" || ev.type === "toolcall_end") {
			this.#refreshStreamTools(el, message);
		}
		this.#maybeScroll();
	}

	commitAssistant(message) {
		// only one assistant message is ever in flight; the final message object
		// is a different clone than the streamed one, so clear the live block and
		// dedupe by fingerprint
		this.#streaming = null;
		if (!this.hasCommitted(message)) {
			this.#messages.push(message);
			this.#renderedFingerprints.push(this.#fingerprint(message));
		}
		this.rebuild();
		this.#maybeScroll();
	}

	// ------------------------------------------------------------------ tools

	handleToolStart({ toolCallId, toolName, args }) {
		this.#toolStates.set(toolCallId, {
			name: toolName,
			args,
			output: "",
			isError: false,
			running: true,
		});
		this.#refreshStreamTools(this.#root.querySelector("[data-live]"), this.#streaming?.message);
		this.#maybeScroll();
	}

	handleToolUpdate({ toolCallId, args, result }) {
		const st = this.#toolStates.get(toolCallId);
		if (st) {
			if (args) st.args = args;
			if (result?.content) st.output = this.#toolOutputText(result);
			if (result?.isError) st.isError = true;
		} else if (result) {
			this.#toolStates.set(toolCallId, {
				name: result.toolName ?? "tool",
				args,
				output: this.#toolOutputText(result),
				isError: !!result.isError,
				running: false,
			});
		}
		this.#refreshStreamTools(this.#root.querySelector("[data-live]"), this.#streaming?.message);
		this.#maybeScroll();
	}

	handleToolEnd({ toolCallId, toolName, result }) {
		const st = this.#toolStates.get(toolCallId) ?? {};
		this.#toolStates.set(toolCallId, {
			name: toolName ?? st.name ?? "tool",
			args: st.args,
			output: result?.content ? this.#toolOutputText(result) : st.output ?? "",
			isError: !!result?.isError,
			running: false,
			details: result?.details,
		});
		this.#refreshStreamTools(this.#root.querySelector("[data-live]"), this.#streaming?.message);
		this.#maybeScroll();
	}

	// ------------------------------------------------------------------ bash

	setBashExcluded(excluded) {
		this.#bashExcluded = Boolean(excluded);
	}

	handleBashDelta(delta) {
		let block = this.#root.querySelector("[data-live-bash]");
		if (!block) {
			block = document.createElement("div");
			block.className = "bash-block" + (this.#bashExcluded ? " excluded" : "");
			block.dataset.liveBash = "";
			block.innerHTML = `<div class="bash-cmd"></div><div class="bash-out"></div>`;
			this.#root.appendChild(block);
		}
		const out = block.querySelector(".bash-out");
		out.textContent += delta;
		this.#maybeScroll();
	}

	// ------------------------------------------------------------- rebuild

	rebuild() {
		const root = this.#root;
		root.innerHTML = "";
		const results = this.#buildResultsMap(this.#messages);
		for (const msg of this.#messages) {
			this.#appendMessageNode(msg, results);
		}
		if (this.#streaming) {
			root.appendChild(this.#buildAssistantBlock(this.#streaming.message, { live: true }));
		}
		this.#renderedFingerprints = this.#messages.map((m) => this.#fingerprint(m));
		this.#maybeScroll();
	}

	#maybeScroll() {
		if (this.#follow) {
			this.#root.scrollTop = this.#root.scrollHeight;
		}
	}

	// -------------------------------------------------------------- builders

	#buildUserBlock(msg) {
		const el = document.createElement("div");
		el.className = "msg msg-user";
		const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
		const skill = parseSkillBlock(this.#textOf(msg));
		const label = document.createElement("div");
		label.className = "msg-label";
		label.textContent = skill ? t("tr.skill", { name: skill.name }) : t("tr.you");
		el.appendChild(label);
		const body = document.createElement("div");
		body.className = "msg-body";
		const text = this.#textOf(msg).trim();
		if (text && !(skill && skill.userMessage === undefined && skill.content === text)) {
			body.textContent = text;
		}
		for (const part of parts) {
			if (part.type === "image") {
				const img = document.createElement("img");
				// SDK ImageContent: { data, mimeType }; older messages may carry
				// the Anthropic-style source object (kept for display fallback)
				const src = part.data
					? `data:${part.mimeType};base64,${part.data}`
					: part.source?.type === "base64"
						? `data:${part.source.mediaType};base64,${part.source.data}`
						: part.source?.url;
				if (src) img.src = src;
				el.appendChild(img);
			}
		}
		el.appendChild(body);
		return el;
	}

	#buildAssistantBlock(msg, { results, live = false } = {}) {
		const resultMap = results instanceof Map ? results : new Map();
		const el = document.createElement("div");
		el.className = "msg msg-assistant";
		if (live) el.dataset.live = "";
		const parts = Array.isArray(msg.content) ? msg.content : [];

		const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("\n");
		if (thinking && !this.#thinkingCollapsed) {
			el.appendChild(this.#buildThinkingBlock(thinking, live));
		}

		for (const part of parts) {
			if (part.type === "text" && part.text) {
				const body = document.createElement("div");
				body.className = "msg-body md";
				body.innerHTML = live ? renderStreamingMarkdown(part.text) : renderMarkdown(part.text);
				body.dataset.role = "text";
				el.appendChild(body);
			} else if (part.type === "thinking" && this.#thinkingCollapsed) {
				const collapsed = document.createElement("div");
				collapsed.className = "thinking";
				collapsed.innerHTML = `<div class="thinking-header">▸ ${escapeHtml(t("tr.thinkingCollapsed"))}</div>`;
				el.appendChild(collapsed);
			} else if (part.type === "toolCall") {
				const liveState = this.#toolStates.get(part.id);
				const result = resultMap.get(part.id);
				el.appendChild(
					this.#buildToolBlock({
						id: part.id,
						name: part.name,
						args: part.arguments ?? part.args,
						result,
						liveState,
						running: !!liveState?.running,
						output: liveState?.output,
						details: liveState?.details ?? result?.details,
						isError: liveState?.isError ?? result?.isError,
					}),
				);
			}
		}

		const stopReason = msg.stopReason;
		if (stopReason === "error" && msg.errorMessage) {
			const err = document.createElement("div");
			err.className = "msg-error";
			err.textContent = `⚠ ${msg.errorMessage}`;
			el.appendChild(err);
		}
		return el;
	}

	#buildThinkingBlock(text, live) {
		const el = document.createElement("div");
		el.className = "thinking";
		const header = document.createElement("div");
		header.className = "thinking-header";
		header.textContent = `▾ ${t("tr.thinking")}`;
		const body = document.createElement("pre");
		body.textContent = text;
		if (live) body.dataset.liveThinking = "";
		header.addEventListener("click", () => {
			const collapsed = header.textContent.startsWith("▸");
			header.textContent = collapsed ? `▾ ${t("tr.thinking")}` : `▸ ${t("tr.thinking")}`;
			body.style.display = collapsed ? "" : "none";
		});
		el.appendChild(header);
		el.appendChild(body);
		return el;
	}

	#buildToolBlock({ id, name, args, result, running, output, details, isError }) {
		const el = document.createElement("div");
		el.className = "tool" + (this.#expandedTools.has(id) ? " open" : "");
		const argsText = this.#summarizeArgs(name, args);
		const head = document.createElement("div");
		head.className = "tool-head";
		head.innerHTML = `<span class="tool-caret">▸</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-args" title="${escapeHtml(argsText)}">${escapeHtml(argsText)}</span>`;
		let statusHtml = "";
		if (running) {
			statusHtml = `<span class="tool-status running">${escapeHtml(t("tr.running"))}</span>`;
		} else if (result || output !== undefined) {
			statusHtml = isError
				? `<span class="tool-status error">✗ ${escapeHtml(t("tr.error"))}</span>`
				: `<span class="tool-status ok">✓ ${escapeHtml(t("tr.done"))}</span>`;
		}
		head.innerHTML += statusHtml;
		el.appendChild(head);

		const body = document.createElement("div");
		body.className = "tool-body";
		const out = result?.content ? this.#toolOutputText(result) : output ?? "";
		const diff = details?.diff ?? (name === "edit" ? details?.patch : undefined);
		if (diff) {
			const diffEl = document.createElement("div");
			diffEl.className = "diff";
			diffEl.innerHTML = renderDiffToHtml(String(diff));
			body.appendChild(diffEl);
		}
		if (out) {
			const pre = document.createElement("pre");
			pre.textContent = out;
			body.appendChild(pre);
		}
		if (!diff && !out && !running) {
			const pre = document.createElement("pre");
			pre.textContent = t("tr.noOutput");
			body.appendChild(pre);
		}
		el.appendChild(body);
		head.addEventListener("click", () => el.classList.toggle("open"));
		return el;
	}

	#buildToolResultBlock(msg) {
		const el = document.createElement("div");
		el.className = "tool";
		el.innerHTML = `<div class="tool-head"><span class="tool-caret">▸</span><span class="tool-name">${escapeHtml(msg.toolName ?? "tool")}</span>${
			msg.isError ? `<span class="tool-status error">✗ ${escapeHtml(t("tr.error"))}</span>` : `<span class="tool-status ok">✓ ${escapeHtml(t("tr.done"))}</span>`
		}</div>`;
		const body = document.createElement("div");
		body.className = "tool-body";
		const pre = document.createElement("pre");
		pre.textContent = this.#toolOutputText(msg);
		body.appendChild(pre);
		el.appendChild(body);
		el.classList.add("open");
		return el;
	}

	#buildBashBlock(msg) {
		const el = document.createElement("div");
		el.className =
			"bash-block" +
			(msg.exitCode && msg.exitCode !== 0 ? " failed" : "") +
			(msg.excludeFromContext ? " excluded" : "");
		const cmd = document.createElement("div");
		cmd.className = "bash-cmd";
		cmd.textContent = `$ ${msg.command}${msg.cancelled ? ` ${t("tr.cancelled")}` : ""}${
			msg.exitCode && msg.exitCode !== 0 ? ` ${t("tr.exit", { code: msg.exitCode })}` : ""
		}`;
		const out = document.createElement("div");
		out.className = "bash-out";
		out.textContent = msg.output || "";
		el.appendChild(cmd);
		el.appendChild(out);
		return el;
	}

	#buildSummaryBlock(summary, label) {
		const el = document.createElement("div");
		el.className = "compaction";
		el.innerHTML = `<div class="compaction-label">${escapeHtml(label)}</div>`;
		const body = document.createElement("div");
		body.className = "md";
		body.innerHTML = renderMarkdown(summary ?? "");
		el.appendChild(body);
		return el;
	}

	#buildCustomBlock(msg) {
		const el = document.createElement("div");
		el.className = "msg msg-custom skill-invocation";
		const text = typeof msg.content === "string" ? msg.content : this.#textOf(msg);
		el.innerHTML = `<div>${renderMarkdown(text)}</div>`;
		if (msg.details?.label) {
			el.dataset.label = msg.details.label;
		}
		return el;
	}

	// ------------------------------------------------------------ live edits

	#updateStreamText(el, text, isDelta) {
		// update the last existing text block (a `:last-of-type` selector would
		// miss once a tool block is the last child, spawning a text node after it)
		const textEls = el.querySelectorAll('[data-role="text"]');
		let textEl = textEls[textEls.length - 1];
		if (!textEl) {
			textEl = document.createElement("div");
			textEl.className = "msg-body md";
			textEl.dataset.role = "text";
			el.appendChild(textEl);
		}
		textEl.innerHTML = renderStreamingMarkdown(text);
	}

	#updateStreamThinking(el, thinking) {
		let thinkingEl = el.querySelector("[data-live-thinking]");
		if (!thinkingEl) {
			const block = this.#buildThinkingBlock(thinking, true);
			el.prepend(block);
			thinkingEl = block.querySelector("[data-live-thinking]");
		}
		if (thinkingEl) thinkingEl.textContent = thinking;
	}

	#refreshStreamTools(el, message) {
		if (!el || !message) return;
		// Re-render only the streaming block's tools by rebuilding it.
		const clone = this.#buildAssistantBlock(message, { live: true });
		el.replaceWith(clone);
	}

	// -------------------------------------------------------------- helpers

	#textOf(msg) {
		if (typeof msg.content === "string") return msg.content;
		if (!Array.isArray(msg.content)) return "";
		return msg.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
	}

	#thinkingOf(msg) {
		if (!Array.isArray(msg.content)) return "";
		return msg.content
			.filter((p) => p.type === "thinking")
			.map((p) => p.thinking ?? "")
			.join("");
	}

	#toolOutputText(result) {
		const content = result.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n");
		}
		return "";
	}

	#summarizeArgs(name, args) {
		if (!args || typeof args !== "object") return "";
		switch (name) {
			case "bash":
			case "powershell":
				return args.command ?? "";
			case "read":
				return args.path + (args.offset ? `:${args.offset}` : "");
			case "write":
			case "edit":
				return args.path ?? "";
			case "grep":
				return `${args.pattern ?? ""} ${args.path ?? ""}`.trim();
			case "find":
				return args.pattern ?? "";
			case "ls":
				return args.path ?? ".";
			default: {
				try {
					const s = JSON.stringify(args);
					return s.length > 120 ? s.slice(0, 117) + "…" : s;
				} catch {
					return "";
				}
			}
		}
	}

	/** Jump helpers for Ctrl+Shift+Up/Down (marked user messages). */
	jumpToUserMessage(direction) {
		const userMsgs = [...this.#root.querySelectorAll(".msg-user")];
		if (userMsgs.length === 0) return;
		const currentTop = this.#root.scrollTop;
		let target = null;
		if (direction < 0) {
			for (const el of userMsgs) {
				if (el.offsetTop < currentTop - 20) target = el;
			}
		} else {
			for (const el of [...userMsgs].reverse()) {
				if (el.offsetTop > currentTop + 20) {
					target = el;
					break;
				}
			}
		}
		target?.scrollIntoView({ behavior: "smooth", block: "start" });
	}
}
