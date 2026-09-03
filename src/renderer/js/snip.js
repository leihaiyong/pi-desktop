/**
 * Screen-region selection overlay (loaded fullscreen by the main process on
 * each display after a screen capture). The user drags a rectangle; on
 * confirm the rect is reported in *image pixels* via window.snip.select(),
 * or cancelled via window.snip.cancel().
 */
import { isValidRect, scaleRect } from "../../shared/snip.js";
import { t, setLanguage, getLanguage } from "../../shared/i18n.js";

const stage = document.getElementById("stage");
const img = document.getElementById("shot");
const sel = document.getElementById("sel");
const label = document.getElementById("sel-label");
const hint = document.getElementById("hint");

let init = null; // { data, mime, imgW, imgH }
let selRect = null; // css px
let dragging = false;
let dragStart = null;

// The stage fills the window exactly, so the live inner size is the correct
// mapping base (avoids any ±1px window-sizing discrepancy).
const scaleX = () => (init ? init.imgW / window.innerWidth : 1);
const scaleY = () => (init ? init.imgH / window.innerHeight : 1);

window.snip?.onInit((payload) => {
	init = payload;
	// main process passes the UI language so the overlay hint matches
	if (payload.lang) setLanguage(payload.lang);
	document.documentElement.lang = getLanguage();
	hint.textContent = t("snap.dragHint");
	img.src = `data:${payload.mime};base64,${payload.data}`;
});

function showSel(r) {
	sel.style.display = "block";
	sel.style.left = `${r.x}px`;
	sel.style.top = `${r.y}px`;
	sel.style.width = `${r.w}px`;
	sel.style.height = `${r.h}px`;
	const w = Math.round(r.w * scaleX());
	const h = Math.round(r.h * scaleY());
	label.textContent = `${w}×${h} px`;
	label.style.display = "block";
	const below = r.y + r.h + 26 < window.innerHeight;
	label.style.left = `${Math.max(2, Math.min(r.x, window.innerWidth - 130))}px`;
	label.style.top = `${below ? r.y + r.h + 7 : Math.max(2, r.y - 24)}px`;
}

function hideSel() {
	sel.style.display = "none";
	label.style.display = "none";
}

function confirmSelection() {
	if (!selRect || !isValidRect(selRect)) return;
	// report the rect in image pixels; main clamps and crops
	window.snip?.select(scaleRect(selRect, scaleX(), scaleY()));
}

stage.addEventListener("mousedown", (e) => {
	if (e.button !== 0) return;
	e.preventDefault();
	dragging = true;
	dragStart = { x: e.clientX, y: e.clientY };
	selRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
	hint.style.display = "none";
});

window.addEventListener("mousemove", (e) => {
	if (!dragging) return;
	selRect = {
		x: Math.min(e.clientX, dragStart.x),
		y: Math.min(e.clientY, dragStart.y),
		w: Math.abs(e.clientX - dragStart.x),
		h: Math.abs(e.clientY - dragStart.y),
	};
	showSel(selRect);
});

window.addEventListener("mouseup", (e) => {
	if (!dragging) return;
	dragging = false;
	if (selRect && selRect.w < 4 && selRect.h < 4) {
		// a plain click (no drag) cancels, like Snipaste
		hideSel();
		window.snip?.cancel();
		return;
	}
});

window.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		e.preventDefault();
		window.snip?.cancel();
	} else if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
		e.preventDefault();
		confirmSelection();
	}
});

stage.addEventListener("contextmenu", (e) => e.preventDefault());
