import { describe, it, expect } from "vitest";
import {
	buildSessionForest,
	flattenSessionForest,
	sessionLabel,
} from "../src/shared/session-tree.js";

const T = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

const S = (over) => ({ path: over.path, updated: over.updated, ...over });

describe("buildSessionForest / flattenSessionForest", () => {
	it("treats independent sessions as depth-0 roots", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "D:\\a\\1.jsonl", updated: T(30) }),
				S({ path: "D:\\a\\2.jsonl", updated: T(10) }),
			])
		);
		expect(flat.map((x) => x.depth)).toEqual([0, 0]);
		// ordered by activity, newest first
		expect(flat.map((x) => x.session.path)).toEqual(["D:\\a\\1.jsonl", "D:\\a\\2.jsonl"]);
	});

	it("nests a forked child under its parent", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "D:\\a\\parent.jsonl", updated: T(10) }),
				S({ path: "D:\\a\\child.jsonl", parentSessionPath: "D:\\a\\parent.jsonl", updated: T(20) }),
			])
		);
		expect(flat).toHaveLength(2);
		expect(flat[0].session.path).toBe("D:\\a\\parent.jsonl");
		expect(flat[0].depth).toBe(0);
		expect(flat[1].session.path).toBe("D:\\a\\child.jsonl");
		expect(flat[1].depth).toBe(1);
	});

	it("keeps a recently-used branch grouped under its parent (subtree activity ordering)", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "D:\\a\\old-parent.jsonl", updated: T(5) }),
				S({ path: "D:\\a\\new-parent.jsonl", updated: T(50) }),
				S({ path: "D:\\a\\hot-child.jsonl", parentSessionPath: "D:\\a\\old-parent.jsonl", updated: T(60) }),
			])
		);
		// old-parent's subtree is newest (60) so it sorts above new-parent (50)
		expect(flat[0].session.path).toBe("D:\\a\\old-parent.jsonl");
		expect(flat[1].session.path).toBe("D:\\a\\hot-child.jsonl");
		expect(flat[1].depth).toBe(1);
		expect(flat[2].session.path).toBe("D:\\a\\new-parent.jsonl");
		expect(flat[2].depth).toBe(0);
	});

	it("matches parents case- and slash-insensitively", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "d:/a/PARENT.jsonl", updated: T(10) }),
				S({ path: "D:\\a\\child.jsonl", parentSessionPath: "d:/a/parent.jsonl", updated: T(20) }),
			])
		);
		expect(flat).toHaveLength(2);
		expect(flat[0].session.path.toLowerCase()).toBe("d:/a/parent.jsonl".toLowerCase());
		expect(flat[1].depth).toBe(1);
	});

	it("treats an orphaned child (parent not in list) as a root", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "D:\\a\\child.jsonl", parentSessionPath: "D:\\gone\\parent.jsonl", updated: T(10) }),
			])
		);
		expect(flat).toHaveLength(1);
		expect(flat[0].depth).toBe(0);
	});

	it("ignores a self-parent (no infinite nesting)", () => {
		const flat = flattenSessionForest(
			buildSessionForest([
				S({ path: "D:\\a\\loop.jsonl", parentSessionPath: "D:\\a\\loop.jsonl", updated: T(10) }),
			])
		);
		expect(flat).toHaveLength(1);
		expect(flat[0].depth).toBe(0);
	});

	it("handles empty / non-array input", () => {
		expect(flattenSessionForest(buildSessionForest([]))).toEqual([]);
		expect(flattenSessionForest(buildSessionForest(null))).toEqual([]);
	});
});

describe("sessionLabel", () => {
	it("prefers the user name, starred", () => {
		expect(sessionLabel({ name: "fix bugs", title: "hello", path: "D:\\a\\x.jsonl" })).toBe("★ fix bugs");
	});

	it("falls back to the first message line, capped", () => {
		const title = "first line\nsecond line";
		expect(sessionLabel({ title, path: "D:\\a\\x.jsonl" })).toBe("first line");
		expect(sessionLabel({ title: "x".repeat(500), path: "D:\\a\\x.jsonl" })).toHaveLength(100);
	});

	it("falls back to the path basename", () => {
		expect(sessionLabel({ path: "D:\\a\\b\\session.jsonl" })).toBe("session.jsonl");
		expect(sessionLabel({ path: "D:/a/b/session.jsonl" })).toBe("session.jsonl");
	});

	it("falls back to a placeholder when nothing is available", () => {
		expect(sessionLabel({})).toBeTruthy();
		expect(sessionLabel(null)).toBeTruthy();
	});
});
