// Evaluates an expression in the first page target of a running Electron app.
// Usage: node scripts/cdp-eval.mjs <port> <js-expression> [waitMs]
import { readFileSync } from "node:fs";

const port = process.argv[2];
// expression: argv[3], or "@file" to read from a file
const exprArg = process.argv[3];
const expr = exprArg?.startsWith("@") ? readFileSync(exprArg.slice(1), "utf8") : exprArg;
const waitMs = Number(process.argv[4] ?? 9000);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
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
const result = await send("Runtime.evaluate", {
	expression: expr,
	returnByValue: true,
	awaitPromise: true,
});
console.log(JSON.stringify(result.result?.value ?? result));
ws.close();
process.exit(0);
