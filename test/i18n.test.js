import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	t,
	tp,
	tCmd,
	setLanguage,
	getLanguage,
	SUPPORTED_LANGUAGES,
} from "../src/shared/i18n.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("i18n basics", () => {
	it("supports English and Chinese", () => {
		expect(SUPPORTED_LANGUAGES.map((l) => l.id)).toEqual(["en", "zh"]);
	});

	it("defaults to English", () => {
		setLanguage("en");
		expect(getLanguage()).toBe("en");
		expect(t("settings.title")).toBe("Settings");
	});

	it("switches to Chinese and back", () => {
		setLanguage("zh");
		expect(getLanguage()).toBe("zh");
		expect(t("settings.title")).toBe("设置");
		setLanguage("en");
	});

	it("ignores unknown languages", () => {
		setLanguage("fr");
		expect(getLanguage()).toBe("en");
	});

	it("interpolates {params}", () => {
		setLanguage("en");
		expect(t("app.workspaceOpened", { cwd: "/tmp/x" })).toBe("Workspace: /tmp/x");
		setLanguage("zh");
		expect(t("app.workspaceOpened", { cwd: "/tmp/x" })).toBe("工作区: /tmp/x");
	});

	it("falls back to the key itself when missing in both locales", () => {
		setLanguage("en");
		expect(t("no.such.key")).toBe("no.such.key");
	});
});

describe("dictionaries", () => {
	const enKeys = new Set();
	const zhKeys = new Set();
	// re-parse the module's tables via behavior: every key used in source must
	// exist in both locales (checked below); here compare the raw tables.
	const src = readFileSync(path.join(here, "..", "src", "shared", "i18n.js"), "utf8");
	const grab = (lang) => {
		const start = src.indexOf(`${lang}: {`);
		const end = src.indexOf(lang === "en" ? "\n\tzh: {" : "\n};", start);
		const block = src.slice(start, end);
		for (const m of block.matchAll(/^\t\t"([^"]+)":/gm)) (lang === "en" ? enKeys : zhKeys).add(m[1]);
	};
	grab("en");
	grab("zh");

	it("both locales are non-trivial", () => {
		expect(enKeys.size).toBeGreaterThan(150);
	});

	it("en and zh have identical key sets", () => {
		const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
		const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
		expect(missingInZh, `missing in zh: ${missingInZh.join(", ")}`).toEqual([]);
		expect(missingInEn, `missing in en: ${missingInEn.join(", ")}`).toEqual([]);
	});

	it("every key used in source exists in both locales", () => {
		const used = new Set();
		const walk = (dir) => {
			for (const entry of readdirSync(dir)) {
				const p = path.join(dir, entry);
				if (statSync(p).isDirectory()) {
					if (entry === "vendor" || entry === "node_modules") continue;
					walk(p);
				} else if (/\.(js|html)$/.test(entry)) {
					const text = readFileSync(p, "utf8");
					for (const m of text.matchAll(/\bt\("([^"]+)"\)/g)) used.add(m[1]);
					for (const m of text.matchAll(/\btp\("([^"]+)"/g)) {
						used.add(`${m[1]}_one`);
						used.add(`${m[1]}_many`);
					}
					for (const m of text.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) used.add(m[1]);
				}
			}
		};
		walk(path.join(here, "..", "src"));
		expect(used.size).toBeGreaterThan(100);
		const missingEn = [...used].filter((k) => !enKeys.has(k));
		const missingZh = [...used].filter((k) => !zhKeys.has(k));
		expect(missingEn, `used but missing in en: ${missingEn.join(", ")}`).toEqual([]);
		expect(missingZh, `used but missing in zh: ${missingZh.join(", ")}`).toEqual([]);
	});
});

describe("tp (plural)", () => {
	it("picks _one for 1", () => {
		setLanguage("en");
		expect(tp("ws.sessions", 1)).toBe("1 session");
		expect(tp("ws.sessions", 5)).toBe("5 sessions");
	});
});

describe("tCmd", () => {
	it("translates builtin command descriptions", () => {
		setLanguage("en");
		expect(tCmd("/new", "fallback")).toBe("Start a new session");
		setLanguage("zh");
		expect(tCmd("/new", "fallback")).toBe("开始新会话");
		setLanguage("en");
	});

	it("falls back to the canonical English description", () => {
		setLanguage("zh");
		expect(tCmd("/some-future-cmd", "My English fallback")).toBe("My English fallback");
		setLanguage("en");
	});
});
