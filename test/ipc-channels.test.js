import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostSrc = readFileSync(path.join(here, "..", "src", "main", "host.js"), "utf8");

describe("IPC channel allow-list", () => {
	const allowed = [...hostSrc.matchAll(/^\t"([a-z][\w.]+)",$/gm)].map((m) => m[1]);
	const dispatched = [...hostSrc.matchAll(/^\t\t\tcase "([a-z][\w.]+)":/gm)].map((m) => m[1]);

	it("allow-list is non-empty", () => {
		expect(allowed.length).toBeGreaterThan(40);
	});

	it("every dispatched channel is allow-listed", () => {
		const missing = [...new Set(dispatched)].filter((c) => !allowed.includes(c));
		expect(missing, `dispatched but not in IPC_CHANNELS: ${missing.join(", ")}`).toEqual([]);
	});
});
