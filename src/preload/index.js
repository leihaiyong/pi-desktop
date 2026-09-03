import { contextBridge, ipcRenderer } from "electron";

const INVOKE_CHANNEL = "pi:invoke";

function invoke(channel, params) {
	return ipcRenderer.invoke(INVOKE_CHANNEL, channel, params).then((res) => {
		if (!res.ok) {
			throw new Error(res.error ?? "Unknown error");
		}
		return res.result;
	});
}

const listeners = new Map();

function on(channel, callback) {
	if (!listeners.has(channel)) {
		listeners.set(channel, new Set());
		ipcRenderer.on(channel, (_event, payload) => {
			for (const cb of listeners.get(channel) ?? []) cb(payload);
		});
	}
	listeners.get(channel).add(callback);
	return () => {
		listeners.get(channel)?.delete(callback);
	};
}

contextBridge.exposeInMainWorld("pi", {
	platform: process.platform,
	versions: { electron: process.versions.electron, chrome: process.versions.chrome },

	// Agent session
	invoke,
	on,

	// Convenience wrappers
	prompt: (text, options) => invoke("session.prompt", { text, ...options }),
	steer: (text) => invoke("session.steer", { text }),
	followUp: (text) => invoke("session.followUp", { text }),
	abort: () => invoke("session.abort"),
	compact: (instructions) => invoke("session.compact", { instructions }),
	abortCompaction: () => invoke("session.compact.abort"),
	setModel: (provider, id) => invoke("session.model.set", { provider, id }),
	cycleModel: (backward) => invoke("session.model.cycle", { backward }),
	setThinking: (level) => invoke("session.thinking.set", { level }),
	cycleThinking: () => invoke("session.thinking.cycle"),
	runBash: (command, excluded = false) => invoke("session.bash.run", { command, excludeFromContext: excluded }),
	abortBash: () => invoke("session.bash.abort"),
	listDisplays: () => invoke("system.displays"),
	captureScreenshot: (index = 0) => invoke("system.screenshot", { index }),
	startScreenshot: () => invoke("system.screenshot.start"),
	notifyUiResponse: (id, value, cancelled) => invoke("ext.ui.respond", { id, value, cancelled }),
	respondAuth: (id, value, cancelled) => invoke("auth.respond", { id, value, cancelled }),
});
