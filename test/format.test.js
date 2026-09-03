import { describe, it, expect } from "vitest";
import {
	formatTokens,
	formatCost,
	formatDuration,
	formatContextUsage,
	formatBytes,
	formatTimestamp,
} from "../src/shared/format.js";

describe("formatTokens", () => {
	it("formats small values verbatim", () => {
		expect(formatTokens(999)).toBe("999");
	});
	it("uses k and M", () => {
		expect(formatTokens(1234)).toBe("1.2k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});
	it("handles undefined", () => {
		expect(formatTokens(undefined)).toBe("0");
	});
});

describe("formatCost", () => {
	it("formats usd", () => {
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(1.5)).toBe("$1.50");
		expect(formatCost(undefined)).toBe("");
	});
});

describe("formatDuration", () => {
	it("formats seconds and minutes", () => {
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(150_000)).toBe("2m 30s");
	});
});

describe("formatContextUsage", () => {
	it("renders the footer context line", () => {
		expect(formatContextUsage({ contextTokens: 12_345, contextWindow: 200_000 })).toBe(
			"12.3k/200k ctx (6%)",
		);
	});
	it("falls back to plain tokens", () => {
		expect(formatContextUsage({ contextTokens: 5000 })).toBe("5k tokens");
	});
	it("returns empty for missing usage", () => {
		expect(formatContextUsage(undefined)).toBe("");
	});
});

describe("formatBytes", () => {
	it("scales units", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
	});
});

describe("formatTimestamp", () => {
	it("formats ISO strings", () => {
		expect(formatTimestamp("2025-01-02T03:04:00.000Z")).toMatch(/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});
	it("passes through unparseable values", () => {
		expect(formatTimestamp("weird")).toBe("weird");
	});
});
