import { describe, it, expect } from "vitest";
import {
	parseMcpJson,
	serializeMcpJson,
	isValidServerName,
	mcpServerKey,
	serverToolCount,
	serverSummary,
	upsertServer,
	updateServer,
	removeServer,
	isMcpOverrideValid,
	MCP_EXPOSURES,
} from "../src/shared/mcp-config.js";

describe("parseMcpJson", () => {
	it("empty text -> empty config", () => {
		const r = parseMcpJson("");
		expect(r.ok).toBe(true);
		expect(r.servers).toEqual({});
	});

	it("parses mcpServers and preserves autoEnableCodemode", () => {
		const text = JSON.stringify({
			mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } },
			autoEnableCodemode: false,
		});
		const r = parseMcpJson(text);
		expect(r.ok).toBe(true);
		expect(r.servers.fs.command).toBe("npx");
		expect(r.autoEnableCodemode).toBe(false);
	});

	it("missing mcpServers key -> empty servers, still ok", () => {
		const r = parseMcpJson('{"foo": 1}');
		expect(r.ok).toBe(true);
		expect(r.servers).toEqual({});
	});

	it("malformed JSON -> ok: false with error", () => {
		const r = parseMcpJson("{nope");
		expect(r.ok).toBe(false);
		expect(r.error).toBeTruthy();
		expect(r.servers).toEqual({});
	});

	it("non-object document -> ok: false", () => {
		expect(parseMcpJson("[1,2]").ok).toBe(false);
		expect(parseMcpJson('"x"').ok).toBe(false);
	});
});

describe("serializeMcpJson", () => {
	it("round-trips through parseMcpJson", () => {
		const servers = { docs: { url: "https://example.com/mcp", exposure: "direct" } };
		const parsed = parseMcpJson(serializeMcpJson(servers, false));
		expect(parsed.ok).toBe(true);
		expect(parsed.servers).toEqual(servers);
		expect(parsed.autoEnableCodemode).toBe(false);
	});

	it("omits autoEnableCodemode when undefined", () => {
		const text = serializeMcpJson({}, undefined);
		expect(text).not.toContain("autoEnableCodemode");
		expect(JSON.parse(text)).toEqual({ mcpServers: {} });
	});
});

describe("isValidServerName", () => {
	it("accepts letters, digits, underscore, dash", () => {
		for (const n of ["fs", "my_server", "my-server", "MCP_1", "a".repeat(64)]) {
			expect(isValidServerName(n)).toBe(true);
		}
	});

	it("rejects empty, too long, and invalid characters", () => {
		for (const n of ["", "a".repeat(65), "has space", "has/slash", "has.dot", "with.dot"]) {
			expect(isValidServerName(n)).toBe(false);
		}
	});
});

describe("mcpServerKey / serverToolCount", () => {
	it("normalizes dashes to underscores like the SDK does", () => {
		expect(mcpServerKey("dev-radius")).toBe("dev_radius");
		expect(serverToolCount(["mcp__dev_radius__read"], "dev-radius")).toBe(1);
	});

	it("only counts this server's tools", () => {
		const tools = ["read", "mcp__fs__a", "mcp__fs__b", "mcp__docs__c"];
		expect(serverToolCount(tools, "fs")).toBe(2);
		expect(serverToolCount(tools, "docs")).toBe(1);
	});

	it("does not prefix-match similar server names", () => {
		expect(serverToolCount(["mcp__fs2__x"], "fs")).toBe(0);
	});

	it("missing tool list -> 0", () => {
		expect(serverToolCount(undefined, "fs")).toBe(0);
	});
});

describe("serverSummary", () => {
	it("stdio server shows command + args", () => {
		expect(serverSummary({ command: "npx", args: ["-y", "fs"] })).toBe("npx -y fs");
	});

	it("http server shows url", () => {
		expect(serverSummary({ url: "https://example.com/mcp" })).toBe("https://example.com/mcp");
	});

	it("transport-less entry is marked as override and notes state", () => {
		expect(serverSummary({ enabled: false })).toBe("override · disabled");
		expect(serverSummary({ enabled: false, exposure: "direct", url: "u" })).toBe("u · direct · disabled");
	});
});

describe("upsertServer / updateServer / removeServer", () => {
	it("upsert appends new servers", () => {
		const next = upsertServer({}, "fs", { command: "npx" });
		expect(next.fs.command).toBe("npx");
	});

	it("upsert merges over existing and preserves unknown fields", () => {
		const next = upsertServer({ fs: { command: "npx", timeout: 90 } }, "fs", { url: "u" });
		expect(next.fs).toMatchObject({ command: "npx", url: "u", timeout: 90 });
	});

	it("upsert keeps previously-set fields the draft does not mention", () => {
		const next = upsertServer({ fs: { url: "old" } }, "fs", { command: "npx" });
		expect(next.fs).toEqual({ url: "old", command: "npx" });
	});

	it("updateServer replaces named fields and drops cleared ones", () => {
		const next = updateServer({ fs: { url: "old", timeout: 90 } }, "fs", { url: undefined, command: "npx" });
		expect(next.fs).toEqual({ timeout: 90, command: "npx" });
	});

	it("updateServer preserves fields outside the form (env/headers/oauth)", () => {
		const next = updateServer(
			{ fs: { url: "u", env: { K: "v" }, headers: { A: "b" } } },
			"fs",
			{ description: "d", command: undefined, args: undefined, url: "u", exposure: undefined, enabled: undefined },
		);
		expect(next.fs).toEqual({ url: "u", env: { K: "v" }, headers: { A: "b" }, description: "d" });
	});

	it("upsert never mutates the input map", () => {
		const servers = { fs: { command: "npx" } };
		upsertServer(servers, "docs", { url: "u" });
		expect(Object.keys(servers)).toEqual(["fs"]);
	});

	it("removeServer drops the entry, keeps others", () => {
		const next = removeServer({ fs: {}, docs: {} }, "fs");
		expect(next).toEqual({ docs: {} });
	});
});

describe("isMcpOverrideValid", () => {
	it("full entries are always valid", () => {
		expect(isMcpOverrideValid("x", { command: "npx" }, {})).toBe(true);
		expect(isMcpOverrideValid("x", { url: "u" }, {})).toBe(true);
		expect(isMcpOverrideValid("x", { type: "stdio" }, {})).toBe(true);
	});

	it("transport-less entries only valid as same-name user overrides", () => {
		expect(isMcpOverrideValid("fs", { enabled: false }, { fs: { command: "npx" } })).toBe(true);
		expect(isMcpOverrideValid("fs", { enabled: false }, {})).toBe(false);
		expect(isMcpOverrideValid("other", { enabled: false }, { fs: {} })).toBe(false);
		expect(isMcpOverrideValid("x", null, { x: {} })).toBe(false);
	});
});

describe("MCP_EXPOSURES", () => {
	it("covers the documented exposure values", () => {
		expect(MCP_EXPOSURES).toEqual(["codemode", "deferred", "direct", "hidden"]);
	});
});
