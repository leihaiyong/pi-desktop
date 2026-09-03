/**
 * Screen-region snip geometry helpers (shared between the selection overlay,
 * the main-process crop, and unit tests).
 *
 * Coordinate spaces:
 *  - css:  CSS pixels inside the fullscreen overlay window (== DIP on Windows)
 *  - img:  pixels of the captured image (physical resolution)
 */

export function isValidRect(v) {
	return (
		v != null &&
		Number.isFinite(v.x) &&
		Number.isFinite(v.y) &&
		Number.isFinite(v.w) &&
		Number.isFinite(v.h) &&
		v.w > 0 &&
		v.h > 0
	);
}

/** Scale a css-space rect into image pixels (the overlay window maps 1:1 onto the display). */
export function scaleRect(rect, scaleX, scaleY) {
	return {
		x: rect.x * scaleX,
		y: rect.y * scaleY,
		w: rect.w * scaleX,
		h: rect.h * scaleY,
	};
}

/**
 * Clamp a crop rect to the image bounds. Returns null when the result is
 * degenerate (<1 px) — callers treat that as "no valid selection".
 */
export function clampCrop(rect, imgW, imgH) {
	if (!isValidRect(rect)) return null;
	const x = Math.max(0, Math.round(rect.x));
	const y = Math.max(0, Math.round(rect.y));
	const right = Math.min(imgW, Math.round(rect.x + rect.w));
	const bottom = Math.min(imgH, Math.round(rect.y + rect.h));
	const w = right - x;
	const h = bottom - y;
	if (w < 1 || h < 1) return null;
	return { x, y, w, h };
}
