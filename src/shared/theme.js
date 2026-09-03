/**
 * Theme color utilities (pure, no electron dependency).
 *
 * pi themes are JSON color palettes (see theme-schema.json in the pi package):
 * { name, vars?, colors: {...}, export?: { pageBg, cardBg, infoBg } }.
 * Color values are hex strings ("#ff0000"), references to `vars`, or 256-color
 * integers (not representable in CSS → treated as absent).
 *
 * resolveThemeToCssVars maps a theme JSON onto the CSS custom properties used
 * by the renderer (main.css).
 */

export function parseHex(value) {
	if (typeof value !== "string") return null;
	const m = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

export function toHex({ r, g, b }) {
	return (
		"#" +
		[r, g, b]
			.map((v) =>
				Math.max(0, Math.min(255, Math.round(v)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")
	);
}

/** Blend `hex` toward `target` (0..255) by `amount` (0..1). */
export function blend(hex, target, amount) {
	const c = parseHex(hex);
	if (!c) return null;
	return toHex({
		r: c.r + (target - c.r) * amount,
		g: c.g + (target - c.g) * amount,
		b: c.b + (target - c.b) * amount,
	});
}

/** hex + alpha → "rgba(r, g, b, a)"; null when unparseable. */
export function withAlpha(hex, a) {
	const c = parseHex(hex);
	if (!c) return null;
	return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** Perceived luminance 0..1 (null when unparseable). */
export function luminance(hex) {
	const c = parseHex(hex);
	if (!c) return null;
	return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/**
 * Resolve a theme JSON (parsed) to CSS custom properties.
 * Returns null when the JSON is unusable.
 */
export function resolveThemeToCssVars(json) {
	if (!json || typeof json !== "object") return null;
	const vars = json.vars ?? {};
	const resolve = (v, depth = 0) => {
		if (depth > 8) return null;
		if (typeof v === "string" && v in vars) return resolve(vars[v], depth + 1);
		return parseHex(v) ? v : null;
	};
	const c = json.colors ?? {};
	const e = json.export ?? {};
	const color = (key) => resolve(c[key]) ?? undefined;

	const pageBg = resolve(e.pageBg) ?? "#101014";
	const cardBg = resolve(e.cardBg) ?? pageBg;
	const light = (luminance(pageBg) ?? 0) > 0.5;
	const fg = color("text") ?? (light ? "#20202a" : "#e8e8f0");
	const muted = color("muted") ?? blend(fg, light ? 0 : 255, 0.45) ?? fg;
	const accent = color("accent") ?? (light ? "#3b6fd4" : "#7aa2f7");
	const border = color("border") ?? blend(fg, light ? 0 : 255, 0.75) ?? "#2a2a35";

	const out = {
		"--bg": pageBg,
		"--bg-alt": blend(pageBg, light ? 0 : 255, 0.06) ?? pageBg,
		"--bg-panel": cardBg,
		"--fg": fg,
		"--muted": muted,
		"--accent": accent,
		"--user": color("userMessageText") ?? fg,
		"--tool": color("toolTitle") ?? fg,
		"--error": color("error") ?? (light ? "#c8405c" : "#f7768e"),
		"--success": color("success") ?? (light ? "#2f8f3b" : "#9ece6a"),
		"--warning": color("warning") ?? (light ? "#a06b10" : "#e0af68"),
		"--border": border,
		"--thinking-bg": withAlpha(accent, 0.07) ?? "transparent",
		"--code-bg": blend(pageBg, light ? 0 : 255, 0.09) ?? pageBg,
	};
	const addFg = color("toolDiffAdded") ?? out["--success"];
	const delFg = color("toolDiffRemoved") ?? out["--error"];
	out["--diff-add-fg"] = addFg;
	out["--diff-del-fg"] = delFg;
	out["--diff-add-bg"] = withAlpha(addFg, 0.12) ?? "transparent";
	out["--diff-del-bg"] = withAlpha(delFg, 0.12) ?? "transparent";
	return out;
}
