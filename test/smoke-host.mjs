/**
 * Headless smoke test: exercises the same pi SDK wiring that the Electron
 * main process uses (services → runtime factory → AgentSessionRuntime →
 * session operations). Run with: node test/smoke-host.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
	ModelRuntime,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-smoke-"));
fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# smoke project\n");

let failures = 0;
function check(name, condition, extra = "") {
	if (condition) {
		console.log(`  ok: ${name}`);
	} else {
		failures++;
		console.error(`  FAIL: ${name} ${extra}`);
	}
}

console.log(`smoke cwd: ${cwd}`);

const modelRuntime = await ModelRuntime.create();
check("model runtime created", !!modelRuntime);
check("model catalog non-empty", modelRuntime.getModels().length > 0, `(${modelRuntime.getModels().length} models)`);
check("providers listed", modelRuntime.getProviders().length > 0);

const services = await createAgentSessionServices({ cwd, modelRuntime });
check("services created", !!services.settingsManager && !!services.resourceLoader);
check("resource loader loaded", Array.isArray(services.resourceLoader.getPrompts()?.prompts));

const factory = async ({ cwd: nextCwd, agentDir, sessionManager, sessionStartEvent }) => {
	const nextServices = await createAgentSessionServices({ cwd: nextCwd, agentDir, modelRuntime });
	const result = await createAgentSessionFromServices({
		services: nextServices,
		sessionManager,
		sessionStartEvent,
	});
	return { ...result, services: nextServices, diagnostics: nextServices.diagnostics };
};

const runtime = await createAgentSessionRuntime(factory, {
	cwd,
	agentDir: getAgentDir(),
	sessionManager: SessionManager.inMemory(cwd),
	sessionStartEvent: { type: "session_start", reason: "start", previousSessionFile: undefined },
});
check("runtime created", !!runtime.session);

const session = runtime.session;
const events = [];
const unsubscribe = session.subscribe((event) => events.push(event.type));
check("session started", !!session.sessionId);
check("thinking level set", ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(session.thinkingLevel));
check("system prompt built", (session.systemPrompt ?? "").length > 100);
check(
	"default tools active",
	["read", "edit", "write"].every((t) => session.getActiveToolNames().includes(t)) &&
		["bash", "powershell"].some((t) => session.getActiveToolNames().includes(t)),
	`(${session.getActiveToolNames().join(",")})`,
);
check("all tools listed", (session.getAllTools() ?? []).length >= 4);
check("context usage available", session.getContextUsage() != null);
check("session stats available", typeof session.getSessionStats() === "object");

// tool switching
session.setActiveToolsByName(["read", "grep"]);
check(
	"tool activation",
	session.getActiveToolNames().join(",") === "read,grep",
	`(${session.getActiveToolNames().join(",")})`,
);
session.setActiveToolsByName(["read", "bash", "edit", "write"]);

// thinking level
const before = session.thinkingLevel;
session.setThinkingLevel("off");
check("thinking level set", session.thinkingLevel === "off");
session.setThinkingLevel(before);

// user message + bash
const bashResult = await session.executeBash("echo pi-desktop-smoke");
check("bash executed", bashResult.exitCode === 0 && bashResult.output.includes("pi-desktop-smoke"), `(${JSON.stringify(bashResult).slice(0, 120)})`);

session.recordBashResult("echo recorded", { output: "recorded\n", exitCode: 0 });
check(
	"bash recorded in messages",
	session.messages.some((m) => m.role === "bashExecution" && m.output.includes("recorded")),
);

// session naming
session.setSessionName("smoke-session");
check("session name set", session.sessionName === "smoke-session");

// fork user messages list (empty ok)
check("fork messages list", Array.isArray(session.getUserMessagesForForking()));

// queue APIs
check("queue clear", session.clearQueue() != null);

// settings snapshot
const sm = session.settingsManager;
check("settings theme readable", typeof sm.getTheme() === "string" || sm.getTheme() === undefined);
sm.setTheme("dark");
check("settings theme set", sm.getTheme() === "dark");

// runtime replacement: new session
const result = await runtime.newSession();
check("new session via runtime", !result.cancelled && !!runtime.session.sessionId);
check(
	"new session has new id",
	runtime.session.sessionId !== session.sessionId,
);

// fork with no entries should throw
let forkThrew = false;
try {
	await runtime.fork("nonexistent-entry");
} catch {
	forkThrew = true;
}
check("fork invalid entry throws", forkThrew);

// dispose
unsubscribe();
await runtime.dispose();
check("runtime disposed", true);

console.log(failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
