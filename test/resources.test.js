import { describe, it, expect } from "vitest";
import { resourceTogglePattern } from "../src/shared/resources.js";

describe("resourceTogglePattern", () => {
	it("skills: relative directory from baseDir (posix)", () => {
		expect(resourceTogglePattern("skill", "/agent/skills/my-skill/SKILL.md", "/agent")).toBe("skills/my-skill");
	});

	it("skills: nested directory", () => {
		expect(resourceTogglePattern("skill", "/agent/skills/sub/my-skill/SKILL.md", "/agent")).toBe("skills/sub/my-skill");
	});

	it("skills: falls back to the directory basename without baseDir", () => {
		expect(resourceTogglePattern("skill", "/agent/skills/my-skill/SKILL.md")).toBe("my-skill");
	});

	it("skills: falls back to basename when the file is outside baseDir", () => {
		expect(resourceTogglePattern("skill", "/elsewhere/pkg/skills/x/SKILL.md", "/agent")).toBe("x");
	});

	it("extensions: relative file path from baseDir", () => {
		expect(resourceTogglePattern("extension", "/agent/extensions/myext.js", "/agent")).toBe("extensions/myext.js");
	});

	it("extensions: nested file", () => {
		expect(resourceTogglePattern("extension", "/agent/extensions/sub/myext.js", "/agent")).toBe("extensions/sub/myext.js");
	});

	it("extensions: falls back to the file basename", () => {
		expect(resourceTogglePattern("extension", "/agent/extensions/myext.js")).toBe("myext.js");
	});

	it("normalizes windows separators to posix", () => {
		expect(resourceTogglePattern("skill", "D:\\agent\\skills\\my-skill\\SKILL.md", "D:\\agent")).toBe("skills/my-skill");
		expect(resourceTogglePattern("extension", "D:\\agent\\extensions\\myext.js", "D:\\agent")).toBe("extensions/myext.js");
	});
});
