import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentHost } from "./host.js";
import { t, setLanguage } from "../shared/i18n.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let host = null;

function parseCliArgs(argv) {
	const opts = { cwd: undefined, session: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--cwd" && argv[i + 1]) {
			opts.cwd = argv[++i];
		} else if (argv[i] === "--session" && argv[i + 1]) {
			opts.session = argv[++i];
		}
	}
	return opts;
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1240,
		height: 820,
		minWidth: 680,
		minHeight: 460,
		title: `Pi Desktop ${app.getVersion()}`,
		backgroundColor: "#101014",
		autoHideMenuBar: false,
		webPreferences: {
			preload: path.join(__dirname, "..", "preload", "index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

	// dev-only smoke harness; never active in packaged builds
	if (!app.isPackaged && process.argv.includes("--smoke")) {
		const smokePrompt = process.env.SMOKE_PROMPT;
		const smokeWaitMs = Number(process.env.SMOKE_WAIT_MS ?? 0);
		mainWindow.webContents.once("did-finish-load", async () => {
			// wait for the agent host to push the initial snapshot
			await new Promise((resolve) => setTimeout(resolve, 6000));
			if (smokePrompt) {
				// multiple prompts are separated by a blank line
				const parts = smokePrompt.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
				for (let i = 0; i < parts.length; i++) {
					try {
						await mainWindow.webContents.executeJavaScript(
							`(() => {
								const el = document.getElementById('editor');
								el.value = ${JSON.stringify(parts[i])};
								el.dispatchEvent(new Event('input', { bubbles: true }));
								el.focus();
								el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
								return true;
							})()`,
						);
						console.log(`SMOKE-PROMPT: sent part ${i + 1}/${parts.length}`);
						await new Promise((resolve) => setTimeout(resolve, smokeWaitMs || 45000));
					} catch (error) {
						console.error(`smoke prompt part ${i + 1} failed`, error);
					}
				}
			}
			try {
				const image = await mainWindow.webContents.capturePage();
				const out = path.join(app.getPath("temp"), `pi-desktop-smoke-${process.pid}.png`);
				fs.writeFileSync(out, image.toPNG());
				console.log(`SMOKE-SHOT: ${out}`);
			} catch (error) {
				console.error("smoke screenshot failed", error);
			}
			app.exit(0);
		});
	}

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) {
			shell.openExternal(url);
		}
		return { action: "deny" };
	});

	mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
		if (level >= 1) {
			console.error(`[renderer] ${message} (${sourceId}:${line})`);
		} else if (process.argv.includes("--dev")) {
			console.log(`[renderer] ${message} (${sourceId}:${line})`);
		}
	});
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		console.error(`[renderer] process gone: ${details.reason}`);
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

function buildMenu() {
	const isMac = process.platform === "darwin";
	const send = (channel) => () => mainWindow?.webContents.send(channel);
	const template = [
		...(isMac ? [{ role: "appMenu" }] : []),
		{
			label: t("menu.file"),
			submenu: [
				{ label: t("menu.openFolder"), click: send("menu:open-folder") },
				{ label: t("menu.openSession"), click: send("menu:open-session") },
				{ type: "separator" },
				{ label: t("menu.newSession"), accelerator: "CmdOrCtrl+N", click: send("menu:new-session") },
				{ label: t("menu.resume"), click: send("menu:resume") },
				{ label: t("menu.workspaces"), click: send("menu:workspaces") },
				{ type: "separator" },
				{ label: t("menu.exportHtml"), click: send("menu:export-html") },
				{ label: t("menu.exportJsonl"), click: send("menu:export-jsonl") },
				{ label: t("menu.saveTranscript"), click: send("menu:save-jsonl") },
				{ type: "separator" },
				isMac ? { role: "close" } : { role: "quit" },
			],
		},
		{
			label: t("menu.edit"),
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: t("menu.session"),
			submenu: [
				{ label: t("menu.newSession"), click: send("menu:new-session") },
				{ label: t("menu.resumeShort"), click: send("menu:resume") },
				{ label: t("menu.forkAt"), click: send("menu:fork") },
				{ label: t("menu.sessionTree"), click: send("menu:tree") },
				{ type: "separator" },
				{ label: t("menu.abort"), accelerator: "CmdOrCtrl+.", click: send("menu:abort") },
				{ label: t("menu.compactNow"), click: send("menu:compact") },
				{ type: "separator" },
				{ label: t("menu.model"), accelerator: "CmdOrCtrl+L", click: send("menu:model") },
				{ label: t("menu.thinkingLevel"), accelerator: "CmdOrCtrl+T", click: send("menu:thinking") },
				{ label: t("menu.theme"), click: send("menu:theme") },
				{ label: t("menu.settings"), click: send("menu:settings") },
			],
		},
		{
			label: t("menu.view"),
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: t("menu.help"),
			submenu: [
				{ label: t("menu.about"), click: () => void showAboutDialog() },
				{ type: "separator" },
				{ label: t("menu.hotkeys"), click: send("menu:hotkeys") },
				{ label: t("menu.helpCommands"), click: send("menu:help") },
				{ type: "separator" },
				{
					label: t("menu.piDocs"),
					click: () => shell.openExternal("https://pi.dev/docs/latest"),
				},
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function showAboutDialog() {
	const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
	await dialog.showMessageBox(win, {
		type: "info",
		title: t("about.title"),
		message: `Pi Desktop v${app.getVersion()}`,
		detail: `Electron ${process.versions.electron}\nNode ${process.version}`,
		buttons: [t("about.ok")],
	});
}

async function start() {
	const cli = parseCliArgs(process.argv);
	await app.whenReady();
	buildMenu();
	createWindow();

	host = new AgentHost(() => mainWindow, (lang) => {
		setLanguage(lang);
		buildMenu();
	});
	try {
		await host.start({
			cwd: cli.cwd ?? process.cwd(),
			sessionPath: cli.session,
			explicitCwd: Boolean(cli.cwd || cli.session),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		dialog.showErrorBox("Pi Desktop", `Failed to start agent session:\n${message}`);
		app.quit();
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
}

app.on("window-all-closed", async () => {
	if (host) {
		try {
			await host.shutdown();
		} catch {
			// best effort
		}
	}
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("before-quit", async (event) => {
	if (host && !host.isShuttingDown()) {
		event.preventDefault();
		try {
			await host.shutdown();
		} finally {
			host?.markShuttingDown();
			app.quit();
		}
	}
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", (_event, argv) => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});
	void start();
}
