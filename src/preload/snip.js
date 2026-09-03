import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload for the screen-region selection overlay (snip.html). Exposes only
 * what the overlay needs: receive the capture payload and report the result.
 */
contextBridge.exposeInMainWorld("snip", {
	onInit(cb) {
		ipcRenderer.once("snip:init", (_event, payload) => cb(payload));
	},
	/** Report the selected rect in image pixels. */
	select(rect) {
		ipcRenderer.send("snip:select", rect);
	},
	/** Cancel the selection (Esc / plain click). */
	cancel() {
		ipcRenderer.send("snip:cancel");
	},
});
