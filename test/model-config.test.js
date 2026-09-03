import { describe, it, expect } from "vitest";
import {
	parseModelsJson,
	serializeModelsJson,
	stripUndefined,
	upsertProvider,
	removeProvider,
	upsertModel,
	removeModel,
	updateCostFields,
} from "../src/shared/model-config.js";

describe("parseModelsJson", () => {
	it("parses a valid providers map", () => {
		const r = parseModelsJson('{"providers":{"ollama":{"baseUrl":"http://x","models":[{"id":"qwen"}]}}}');
		expect(r.ok).toBe(true);
		expect(Object.keys(r.providers)).toEqual(["ollama"]);
	});

	it("returns ok with empty providers when the file has no providers key", () => {
		const r = parseModelsJson("{}");
		expect(r.ok).toBe(true);
		expect(r.providers).toEqual({});
	});

	it("returns ok:false with an error for malformed JSON", () => {
		const r = parseModelsJson("{ nope");
		expect(r.ok).toBe(false);
		expect(r.error).toBeTruthy();
		expect(r.providers).toEqual({});
	});

	it("treats non-object providers as empty", () => {
		expect(parseModelsJson('{"providers":[1]}').providers).toEqual({});
		expect(parseModelsJson('"str"').providers).toEqual({});
	});
});

describe("serializeModelsJson", () => {
	it("round-trips through parse", () => {
		const providers = { ollama: { baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3" }] } };
		const text = serializeModelsJson(providers);
		expect(text.endsWith("\n")).toBe(true);
		expect(parseModelsJson(text).providers).toEqual(providers);
	});
});

describe("stripUndefined", () => {
	it("drops undefined values only", () => {
		expect(stripUndefined({ a: 1, b: undefined, c: 0, d: "" })).toEqual({ a: 1, c: 0, d: "" });
	});
});

describe("upsertProvider / removeProvider", () => {
	const providers = {
		ollama: { baseUrl: "http://a", models: [{ id: "m1" }], customField: "kept" },
	};

	it("merges a draft over an existing provider and preserves unknown fields", () => {
		const next = upsertProvider(providers, "ollama", { baseUrl: "http://b", customField: undefined });
		expect(next.ollama.baseUrl).toBe("http://b");
		expect(next.ollama.models).toEqual([{ id: "m1" }]);
		expect(next.ollama.customField).toBe("kept");
		expect(providers.ollama.baseUrl).toBe("http://a"); // input not mutated
	});

	it("creates a new provider", () => {
		const next = upsertProvider(providers, "lmstudio", { baseUrl: "http://c" });
		expect(next.lmstudio).toEqual({ baseUrl: "http://c" });
	});

	it("removeProvider leaves other providers intact", () => {
		const next = removeProvider(providers, "ollama");
		expect(next).toEqual({});
	});
});

describe("upsertModel / removeModel", () => {
	const provider = { baseUrl: "http://a", models: [{ id: "m1", name: "One" }] };

	it("appends a new model", () => {
		const next = upsertModel(provider, { id: "m2" });
		expect(next.models.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(provider.models).toHaveLength(1); // input not mutated
	});

	it("replaces an existing model in place by id", () => {
		const next = upsertModel(provider, { id: "m1", name: "Renamed" });
		expect(next.models).toEqual([{ id: "m1", name: "Renamed" }]);
	});

	it("removes a model by id", () => {
		expect(removeModel(provider, "m1").models).toEqual([]);
	});
});

describe("updateCostFields", () => {
	it("sets $/M values as-is (the file stores per-1M-token rates)", () => {
		expect(updateCostFields(undefined, "2.5", "10")).toEqual({ input: 2.5, output: 10 });
	});

	it("allows zero cost (free local models)", () => {
		expect(updateCostFields(undefined, "0", "0")).toEqual({ input: 0, output: 0 });
	});

	it("empty values clear fields; no fields left -> undefined (omitted from the file)", () => {
		expect(updateCostFields({ input: 1, output: 2 }, "", "")).toBeUndefined();
		expect(updateCostFields(undefined, "", "")).toBeUndefined();
	});

	it("preserves unknown cost keys (cacheRead/cacheWrite/tiers)", () => {
		expect(updateCostFields({ input: 1, cacheRead: 0.5, tiers: [1] }, "", "")).toEqual({
			cacheRead: 0.5,
			tiers: [1],
		});
	});

	it("ignores invalid input (treated as cleared)", () => {
		expect(updateCostFields(undefined, "abc", "-3")).toBeUndefined();
		expect(updateCostFields({ input: 9 }, "abc", "")).toBeUndefined();
	});
});
