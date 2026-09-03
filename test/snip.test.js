import { describe, it, expect } from "vitest";
import { isValidRect, scaleRect, clampCrop } from "../src/shared/snip.js";

describe("isValidRect", () => {
	it("accepts finite positive rects", () => {
		expect(isValidRect({ x: 0, y: 0, w: 10, h: 5 })).toBe(true);
		expect(isValidRect({ x: 1.5, y: -2, w: 10, h: 5 })).toBe(true);
	});
	it("rejects non-rects", () => {
		expect(isValidRect(null)).toBe(false);
		expect(isValidRect({ x: 0, y: 0, w: 0, h: 5 })).toBe(false);
		expect(isValidRect({ x: NaN, y: 0, w: 5, h: 5 })).toBe(false);
		expect(isValidRect({ x: 0, y: 0, w: 5 })).toBe(false);
	});
});

describe("scaleRect", () => {
	it("scales css pixels to image pixels", () => {
		expect(scaleRect({ x: 10, y: 20, w: 100, h: 50 }, 1.5, 1.5)).toEqual({
			x: 15,
			y: 30,
			w: 150,
			h: 75,
		});
	});
	it("supports anisotropic scaling", () => {
		expect(scaleRect({ x: 10, y: 20, w: 100, h: 50 }, 2, 1)).toEqual({
			x: 20,
			y: 20,
			w: 200,
			h: 50,
		});
	});
});

describe("clampCrop", () => {
	const IMG = { w: 100, h: 100 };

	it("keeps in-bounds rects unchanged", () => {
		expect(clampCrop({ x: 10, y: 20, w: 30, h: 40 }, IMG.w, IMG.h)).toEqual({
			x: 10,
			y: 20,
			w: 30,
			h: 40,
		});
	});
	it("clamps to the right/bottom edges", () => {
		expect(clampCrop({ x: 90, y: 95, w: 50, h: 50 }, IMG.w, IMG.h)).toEqual({
			x: 90,
			y: 95,
			w: 10,
			h: 5,
		});
	});
	it("clamps negative origins to 0", () => {
		expect(clampCrop({ x: -10, y: -20, w: 30, h: 30 }, IMG.w, IMG.h)).toEqual({
			x: 0,
			y: 0,
			w: 20,
			h: 10,
		});
	});
	it("returns null for degenerate results", () => {
		expect(clampCrop({ x: 200, y: 200, w: 10, h: 10 }, IMG.w, IMG.h)).toBe(null);
		expect(clampCrop({ x: 150, y: 0, w: 10, h: 10 }, IMG.w, IMG.h)).toBe(null);
	});
	it("returns null for invalid rects", () => {
		expect(clampCrop(null, IMG.w, IMG.h)).toBe(null);
		expect(clampCrop({ x: NaN, y: 0, w: 5, h: 5 }, IMG.w, IMG.h)).toBe(null);
	});
	it("rounds the crop edges (not the size, to avoid drift)", () => {
		// w = round(10.4 + 30.2) - round(10.4) = 41 - 10 = 31
		expect(clampCrop({ x: 10.4, y: 20.6, w: 30.2, h: 40.9 }, IMG.w, IMG.h)).toEqual({
			x: 10,
			y: 21,
			w: 31,
			h: 41,
		});
	});
});
