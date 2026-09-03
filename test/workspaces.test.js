import { describe, it, expect } from "vitest";
import { groupWorkspaces, workspaceName } from "../src/shared/workspaces.js";

const t = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

const sessions = [
	{ cwd: "D:\\proj\\alpha", modified: t(10), messageCount: 1 },
	{ cwd: "D:\\proj\\alpha", modified: t(30), messageCount: 2 },
	{ cwd: "D:\\proj\\beta", modified: t(20), messageCount: 1 },
	{ cwd: "C:\\work", modified: t(5), messageCount: 3 },
	{ cwd: "", modified: t(40), messageCount: 9 }, // legacy, no cwd — skipped
];

describe("workspaceName", () => {
	it("takes the last path segment", () => {
		expect(workspaceName("D:\\proj\\alpha")).toBe("alpha");
		expect(workspaceName("/home/u/work")).toBe("work");
		expect(workspaceName("D:\\")).toBe("D:");
		expect(workspaceName("")).toBe("");
	});
});

describe("groupWorkspaces", () => {
	it("groups by cwd, counts sessions, tracks last modified", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "" });
		expect(ws.map((w) => w.cwd)).toEqual(["D:\\proj\\alpha", "D:\\proj\\beta", "C:\\work"]);
		const alpha = ws[0];
		expect(alpha.sessionCount).toBe(2);
		expect(new Date(alpha.lastModified).toISOString()).toBe(t(30));
		expect(alpha.name).toBe("alpha");
	});

	it("skips sessions without a cwd", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "" });
		// 2 (alpha) + 1 (beta) + 1 (work); the legacy cwd-less row is skipped
		expect(ws.reduce((n, w) => n + w.sessionCount, 0)).toBe(4);
	});

	it("sorts most recently used first", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "" });
		expect(ws[0].cwd).toBe("D:\\proj\\alpha"); // 30 > 20 > 5
		expect(ws[2].cwd).toBe("C:\\work");
	});

	it("pins the current workspace first even without sessions", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "E:\\live" });
		expect(ws[0].cwd).toBe("E:\\live");
		expect(ws[0].isCurrent).toBe(true);
		expect(ws[0].sessionCount).toBe(0);
		const alpha = ws.find((w) => w.cwd === "D:\\proj\\alpha");
		expect(alpha.isCurrent).toBe(false);
	});

	it("marks the current workspace when it has sessions", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "D:\\proj\\beta" });
		expect(ws[0].cwd).toBe("D:\\proj\\beta");
		expect(ws[0].isCurrent).toBe(true);
	});

	it("respects the limit", () => {
		const ws = groupWorkspaces(sessions, { currentCwd: "", limit: 2 });
		expect(ws).toHaveLength(2);
	});

	it("handles empty input", () => {
		expect(groupWorkspaces([], { currentCwd: "" })).toEqual([]);
		expect(groupWorkspaces(null, { currentCwd: "X:\\y" })).toHaveLength(1);
	});
});
