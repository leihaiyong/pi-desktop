import { describe, it, expect } from "vitest";
import { groupWorkspaces, workspaceName, sortWorkspaces, WORKSPACE_SORTS } from "../src/shared/workspaces.js";

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

	it("carries per-workspace sessions, recent first and capped, without changing the count", () => {
		const s = [
			{ cwd: "D:\\alpha", path: "p-old", modified: t(10) },
			{ cwd: "D:\\alpha", path: "p-mid", modified: t(20) },
			{ cwd: "D:\\alpha", path: "p-new", modified: t(30) },
		];
		const ws = groupWorkspaces(s, { currentCwd: "", sessionLimit: 2 });
		const alpha = ws.find((w) => w.cwd === "D:\\alpha");
		expect(alpha.sessions.map((x) => x.path)).toEqual(["p-new", "p-mid"]);
		expect(alpha.sessionCount).toBe(3);
	});

	it("handles empty input", () => {
		expect(groupWorkspaces([], { currentCwd: "" })).toEqual([]);
		expect(groupWorkspaces(null, { currentCwd: "X:\\y" })).toHaveLength(1);
	});
});

describe("sortWorkspaces", () => {
	const ws = [
		{ cwd: "D:\\beta", name: "beta", isCurrent: false, sessionCount: 1, lastModified: 300 },
		{ cwd: "D:\\alpha", name: "alpha", isCurrent: false, sessionCount: 2, lastModified: 100 },
		{ cwd: "D:\\gamma", name: "gamma", isCurrent: false, sessionCount: 1, lastModified: 200 },
	];

	it("recent: newest lastModified first", () => {
		expect(sortWorkspaces(ws, "recent").map((w) => w.name)).toEqual(["beta", "gamma", "alpha"]);
	});

	it("name: alphabetical", () => {
		expect(sortWorkspaces(ws, "name").map((w) => w.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("pins the current workspace first in both modes", () => {
		const withCurrent = ws.map((w) => (w.name === "gamma" ? { ...w, isCurrent: true } : w));
		expect(sortWorkspaces(withCurrent, "recent").map((w) => w.name)).toEqual(["gamma", "beta", "alpha"]);
		expect(sortWorkspaces(withCurrent, "name").map((w) => w.name)).toEqual(["gamma", "alpha", "beta"]);
	});

	it("exposes the sort modes", () => {
		expect(WORKSPACE_SORTS).toEqual(["recent", "name"]);
	});
});

describe("groupWorkspaces sort option", () => {
	const sessions = [
		{ cwd: "D:\\beta", modified: "2026-01-01T00:03:00Z", messageCount: 1 },
		{ cwd: "D:\\alpha", modified: "2026-01-01T00:01:00Z", messageCount: 1 },
		{ cwd: "D:\\gamma", modified: "2026-01-01T00:02:00Z", messageCount: 1 },
	];

	it("sorts by name when requested", () => {
		expect(groupWorkspaces(sessions, { currentCwd: "", sort: "name" }).map((w) => w.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("defaults to most-recently-used", () => {
		expect(groupWorkspaces(sessions, { currentCwd: "" }).map((w) => w.name)).toEqual(["beta", "gamma", "alpha"]);
	});
});
