/**
 * Formatting helpers for footer/status display.
 */

function trimZero(value) {
	const s = value.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatTokens(n) {
	if (n == null || Number.isNaN(n)) return "0";
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${v >= 100 ? Math.round(v) : trimZero(v)}M`;
	}
	if (n >= 1_000) {
		const v = n / 1_000;
		return `${v >= 100 ? Math.round(v) : trimZero(v)}k`;
	}
	return String(n);
}

export function formatCost(usd) {
	if (usd == null || Number.isNaN(usd)) return "";
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms) {
	if (ms == null) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

export function formatTimestamp(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatBytes(n) {
	if (n == null) return "";
	const units = ["B", "KB", "MB", "GB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	const num = v >= 10 || i === 0 ? Math.round(v) : trimZero(v);
	return `${num} ${units[i]}`;
}

/**
 * Context usage line like the TUI footer: "12.3k/200k tokens (6%)".
 */
export function formatContextUsage(usage) {
	if (!usage) return "";
	const total = usage.contextTokens ?? usage.tokens ?? 0;
	const window = usage.contextWindow ?? usage.maxContextTokens;
	if (!window) return `${formatTokens(total)} tokens`;
	const pct = Math.min(100, Math.round((total / window) * 100));
	return `${formatTokens(total)}/${formatTokens(window)} ctx (${pct}%)`;
}
