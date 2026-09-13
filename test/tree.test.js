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

	it("indents by branch, staying flat for single-child chains", () => {
		//     a
		//     b
		//    / \
		//   c   e
		//   |
		//   d
		const rows = flattenTree(entries, "d");
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.a.depth).toBe(0);
		expect(byId.b.depth).toBe(0); // single-child chain stays flat
		expect(byId.c.depth).toBe(1); // b branches (c, e) -> +1
		expect(byId.e.depth).toBe(1); // sibling branch, same level
		expect(byId.d.depth).toBe(2); // first generation after a branch -> +1
	});

	it("keeps a long linear session flat even with one end fork", () => {
		// A ~3000-entry straight chain that forks only at the very end must not
		// be drawn as a 3000-deep staircase (regression: off-screen indent).
		const N = 3000;
		const long = [{ id: "r", parentId: null, type: "session" }];
		for (let i = 1; i < N; i++) long.push({ id: `n${i}`, parentId: `n${i - 1}` });
		const last = long[long.length - 1];
		long.push({ id: "fa", parentId: last.id });
		long.push({ id: "fa2", parentId: "fa" });
		long.push({ id: "fb", parentId: last.id });
		const rows = flattenTree(long, "fa2");
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.n1000.depth).toBe(0); // the long chain stays flat
		expect(byId.n2999.depth).toBe(0); // ...including the branch point itself
		expect(byId.fa.depth).toBe(1); // the fork -> +1
		expect(byId.fb.depth).toBe(1);
		expect(byId.fa2.depth).toBe(2); // first gen after a branch -> +1
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
