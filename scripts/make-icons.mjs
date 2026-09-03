/**
 * Generates build/icon.ico and build/icon.icns for Pi Desktop.
 * Pure Node (no image deps): draws a "π" mark on a rounded dark tile and
 * emits PNG-compressed ICO (Vista+) and ICNS (ic07, 128x128 PNG).
 *
 * Run: node scripts/make-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "build");

// ---------------------------------------------------------------- pixel art

function renderTile(size) {
	// RGBA buffer, top-left origin
	const px = Buffer.alloc(size * size * 4);
	const s = size / 256; // scale factor relative to 256 design
	const bg = { r: 16, g: 16, b: 20, a: 255 }; // #101014
	const fg = { r: 122, g: 162, b: 247, a: 255 }; // #7aa2f7
	const radius = 48 * s;

	const insideRoundedRect = (x, y) => {
		const minX = 0;
		const maxX = size;
		const r = radius;
		if (x < minX || x >= maxX || y < 0 || y >= size) return false;
		const cx = Math.min(Math.max(x, minX + r), maxX - 1 - r);
		const cy = Math.min(Math.max(y, r), size - 1 - r);
		const dx = x - cx;
		const dy = y - cy;
		return dx * dx + dy * dy <= r * r || x >= minX + r && x < maxX - r || y >= r && y < size - r;
	};

	const inPi = (x, y) => {
		// π in 256 design units: top bar + two legs
		const X = x / s;
		const Y = y / s;
		const bar = X >= 44 && X <= 212 && Y >= 74 && Y <= 100;
		const leftLeg = X >= 78 && X <= 104 && Y >= 74 && Y <= 196;
		const rightLeg = X >= 152 && X <= 178 && Y >= 74 && Y <= 196;
		// small serif feet
		const leftFoot = X >= 62 && X <= 120 && Y >= 178 && Y <= 196;
		const rightFoot = X >= 136 && X <= 194 && Y >= 178 && Y <= 196;
		return bar || leftLeg || rightLeg || leftFoot || rightFoot;
	};

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			if (!insideRoundedRect(x + 0.5, y + 0.5)) {
				// transparent
				continue;
			}
			const c = inPi(x, y) ? fg : bg;
			px[i] = c.r;
			px[i + 1] = c.g;
			px[i + 2] = c.b;
			px[i + 3] = c.a;
		}
	}
	return px;
}

// ---------------------------------------------------------------- png encode

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typeBuf = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
	return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	// raw scanlines with filter byte 0
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0;
		rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}
	const idat = zlib.deflateSync(raw, { level: 9 });
	return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- ico / icns

function encodeIco(png256) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(1, 4); // count
	const entry = Buffer.alloc(16);
	entry[0] = 0; // width 0 = 256
	entry[1] = 0; // height 0 = 256
	entry[2] = 0; // colors
	entry[3] = 0; // reserved
	entry.writeUInt16LE(1, 4); // planes
	entry.writeUInt16LE(32, 6); // bpp
	entry.writeUInt32LE(png256.length, 8);
	entry.writeUInt32LE(22, 12); // offset
	return Buffer.concat([header, entry, png256]);
}

function encodeIcns(png128) {
	// icns = "icns" + total size (BE), then entries: type + size(BE, incl 8) + data
	const entry = Buffer.concat([Buffer.from("ic07", "ascii"), png128]);
	const head = Buffer.alloc(8);
	head.write("icns", "ascii");
	head.writeUInt32BE(8 + 8 + png128.length, 4);
	const meta = Buffer.alloc(8);
	meta.write("ic07", "ascii");
	meta.writeUInt32BE(8 + png128.length, 4);
	return Buffer.concat([head, meta, entry]);
}

// -------------------------------------------------------------------- main

fs.mkdirSync(outDir, { recursive: true });
const png256 = encodePng(256, renderTile(256));
const png128 = encodePng(128, renderTile(128));

fs.writeFileSync(path.join(outDir, "icon.ico"), encodeIco(png256));
fs.writeFileSync(path.join(outDir, "icon.icns"), encodeIcns(png128));
// also a plain png for linux (electron-builder accepts a 512+ png dir or png)
fs.writeFileSync(path.join(outDir, "icon.png"), encodePng(256, renderTile(256)));
console.log(`wrote ${path.join(outDir, "icon.ico")} (${fs.statSync(path.join(outDir, "icon.ico")).size} bytes)`);
console.log(`wrote ${path.join(outDir, "icon.icns")} (${fs.statSync(path.join(outDir, "icon.icns")).size} bytes)`);
console.log(`wrote ${path.join(outDir, "icon.png")} (${fs.statSync(path.join(outDir, "icon.png")).size} bytes)`);
