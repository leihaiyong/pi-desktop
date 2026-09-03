// Captures a screenshot of a running Electron app via CDP.
// Usage: node scripts/cdp-shot.mjs <debug-port> <out.png> [waitMs]
import fs from "node:fs";

const port = process.argv[2] ?? "9333";
const out = process.argv[3] ?? "cdp-shot.png";
const waitMs = Number(process.argv[4] ?? 8000);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target: " + JSON.stringify(targets));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
	new Promise((resolve, reject) => {
		const mid = ++id;
		pending.set(mid, { resolve, reject });
		ws.send(JSON.stringify({ id: mid, method, params }));
	});
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
	}
};
await new Promise((resolve) => (ws.onopen = resolve));

await new Promise((resolve) => setTimeout(resolve, waitMs));
const { data } = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(out, Buffer.from(data, "base64"));
console.log("saved", out);
ws.close();
process.exit(0);
