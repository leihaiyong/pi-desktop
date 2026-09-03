import { describe, it, expect } from "vitest";
import { flattenTree, countBranches } from "../src/shared/tree.js";

describe("flattenTree", () => {
	const entries = [
		{ id: "a", parentId: null, type: "session" },
		{ id: "b", parentId: "a", type: "message", role: "user", text: "hi" },
		{ id: "c", parentId: "b", type: "message", role: "assistant", text: "hello" },
		{ id: "d", parentId: "c", type: "message", role: "user", text: "forked" },
		{ id: "e", parentId: "b", type: "message", role: "assistant", text: "alt" },
	];

	it("assigns depth per tree position", () => {
		const rows = flattenTree(entries, "d");
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.a.depth).toBe(0);
		expect(byId.b.depth).toBe(1);
		expect(byId.c.depth).toBe(2);
		expect(byId.d.depth).toBe(3);
		expect(byId.e.depth).toBe(2);
	});

	it("marks the leaf", () => {
		const rows = flattenTree(entries, "e");
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.e.isLeaf).toBe(true);
		expect(byId.d.isLeaf).toBe(false);
	});

	it("handles cycles defensively", () => {
		const cyclic = [
			{ id: "x", parentId: "y", type: "message" },
			{ id: "y", parentId: "x", type: "message" },
		];
		const rows = flattenTree(cyclic, "x");
		expect(rows).toHaveLength(2);
	});
});

describe("countBranches", () => {
	it("counts nodes with more than one child", () => {
		const entries = [
			{ id: "a", parentId: null },
			{ id: "b", parentId: "a" },
			{ id: "c", parentId: "a" },
			{ id: "d", parentId: "b" },
		];
		expect(countBranches(entries)).toBe(1);
	});

	it("is zero for a linear history", () => {
		const entries = [
			{ id: "a", parentId: null },
			{ id: "b", parentId: "a" },
			{ id: "c", parentId: "b" },
		];
		expect(countBranches(entries)).toBe(0);
	});
});
