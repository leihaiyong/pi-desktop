// Repacks the pi-desktop app into the electron-builder output asar so the
// packaged app can be exercised without a full (toolchain-blocked) build.
//
// Two complications vs. a naive walk:
// 1. The pi packages are npm `file:` junctions into the local monorepo, whose
//    packages junction-reference each other (cycles) -> realpath cycle guard.
// 2. When pi-desktop depends on the pi packages via `file:` links, npm does
//    not install the pi packages' own dependencies
//    into pi-desktop/node_modules; they live hoisted in the monorepo root
//    (pi/node_modules). We therefore compute the runtime dependency closure
//    of the pi packages and merge packages from both node_modules trees
//    (the monorepo tree is ignored for registry installs).
//
// Packing uses createPackageFromStreams so each asar entry can be read from a
// different source root (pi-desktop vs. the monorepo).
import asarPkg from "@electron/asar";
const { createPackageFromStreams } = asarPkg;
import fs from "node:fs";
import path from "node:path";

// Usage: node scripts/repack-asar.mjs [root] [pi-mono-root] [dest-asar]
const root = process.argv[2] ?? process.cwd();
const monoRoot = process.argv[3] ?? path.join(path.dirname(root), "pi");
const dest = process.argv[4] ?? path.join(root, "release/win-unpacked/resources/app.asar");

const nmDesktop = path.join(root, "node_modules");
const nmMono = path.join(monoRoot, "node_modules");
// The monorepo tree is only present when pi-desktop depends on the pi
// packages via `file:` links; for registry installs it is skipped.
const hasMono = fs.existsSync(nmMono);

// ---------------------------------------------------------------------------
// 1. Collect the set of top-level package names needed in the asar.
// ---------------------------------------------------------------------------
function topLevelNames(nmDir) {
	const names = new Set();
	for (const e of fs.readdirSync(nmDir, { withFileTypes: true })) {
		if (e.name.startsWith(".") || e.name === ".bin") continue;
		if (e.name.startsWith("@")) {
			for (const sub of fs.readdirSync(path.join(nmDir, e.name), { withFileTypes: true })) {
				names.add(`${e.name}/${sub.name}`);
			}
		} else {
			names.add(e.name);
		}
	}
	return names;
}

function pkgJsonFor(name, nmDir) {
	const p = path.join(nmDir, ...name.split("/"));
	try {
		return JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"));
	} catch {
		return null;
	}
}

// Start from pi-desktop's runtime dependencies (not devDeps like electron),
// then close over the runtime deps of every required package.
const appPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const required = new Set(Object.keys(appPkg.dependencies ?? {}));
// Make sure every @earendil-works workspace package reachable from the pi
// packages is present, even if not directly named above.
for (const n of hasMono ? topLevelNames(nmMono) : [])
	if (n.startsWith("@earendil-works/")) required.add(n);

let changed = true;
while (changed) {
	changed = false;
	for (const name of [...required]) {
		const pkg = pkgJsonFor(name, nmDesktop) ?? pkgJsonFor(name, nmMono);
		if (!pkg) continue;
		for (const dep of Object.keys(pkg.dependencies ?? {})) {
			if (!required.has(dep)) {
				required.add(dep);
				changed = true;
			}
		}
	}
}
console.log(`required packages: ${required.size}`);

// ---------------------------------------------------------------------------
// 2. Walk the selected packages (plus app source) into {rel, src} entries.
// ---------------------------------------------------------------------------
const entries = [];
const seenDirs = new Set();
const seenFiles = new Set();

function include(relPosix) {
	if (relPosix === "package.json") return true;
	if (relPosix === "src" || relPosix.startsWith("src/")) return true;
	if (relPosix === "node_modules" || relPosix.startsWith("node_modules/")) {
		if (relPosix.includes("/test/") || relPosix.includes("/tests/")) return false;
		if (relPosix.includes("/.github/")) return false;
		if (relPosix.includes("/.vscode/")) return false;
		if (relPosix.endsWith(".md")) return false;
		if (relPosix.endsWith(".map")) return false;
		return true;
	}
	return false;
}

function addFile(full, relPosix) {
	if (!include(relPosix)) return;
	let st;
	try {
		st = fs.lstatSync(full); // rejects phantom/reparse-point entries
	} catch {
		return;
	}
	if (!st.isFile() && !st.isSymbolicLink()) return;
	let src;
	try {
		src = fs.realpathSync(full);
	} catch {
		return;
	}
	if (seenFiles.has(src)) return;
	seenFiles.add(src);
	let size = st.size;
	try {
		size = fs.statSync(src).size;
	} catch {
		return;
	}
	entries.push({ rel: relPosix, src, size });
}

function walk(dir, rel) {
	let real;
	try {
		real = fs.realpathSync(dir);
	} catch {
		return;
	}
	if (seenDirs.has(real)) return;
	seenDirs.add(real);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		const r = rel ? `${rel}/${name}` : name;
		let st;
		try {
			st = fs.lstatSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full, r);
		} else if (st.isFile() || st.isSymbolicLink()) {
			addFile(full, r);
		}
	}
}

// App source + package.json (from pi-desktop)
for (const name of fs.readdirSync(root)) {
	const full = path.join(root, name);
	const st = fs.lstatSync(full);
	if (name === "package.json") addFile(full, "package.json");
	else if (name === "src" && st.isDirectory()) walk(full, "src");
}

// node_modules: prefer the pi-desktop copy, fall back to the monorepo root
for (const name of [...required].sort()) {
	let dir = path.join(nmDesktop, ...name.split("/"));
	let st;
	try {
		st = fs.lstatSync(dir);
	} catch {
		st = null;
	}
	if (!st?.isDirectory() && !st?.isSymbolicLink()) {
		dir = path.join(nmMono, ...name.split("/"));
	}
	walk(dir, `node_modules/${name}`);
}

console.log(`collecting ${entries.length} files...`);
await createPackageFromStreams(
	dest,
	entries.map((e) => ({
		path: e.rel,
		type: "file",
		stat: { mode: 0o644, size: e.size },
		streamGenerator: () => fs.createReadStream(e.src),
	})),
);
normalizeAsarPaths(dest);
console.log(`packed ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);

// @electron/asar normalizes entry names with path.normalize(), which on
// Windows produces backslashes. Electron's asar loader expects forward
// slashes, so rewrite the header keys in place.
// Layout: [UInt32: 4][UInt32: headerBufLen][UInt32: payloadSize][UInt32: strLen][JSON][pad][data]
function normalizeAsarPaths(asarPath) {
	const buf = fs.readFileSync(asarPath);
	if (buf.readUInt32LE(0) !== 4) throw new Error(`unexpected asar header layout at ${asarPath}`);
	const headerBufLen = buf.readUInt32LE(4);
	const payloadSize = buf.readUInt32LE(8);
	const jsonLen = buf.readUInt32LE(12);
	if (payloadSize !== ((4 + jsonLen + 3) & ~3) || headerBufLen !== 4 + payloadSize) {
		throw new Error(`unexpected asar header layout at ${asarPath}`);
	}
	const json = buf.toString("utf8", 16, 16 + jsonLen);
	const header = JSON.parse(json);
	const fix = (node) => {
		if (!node || typeof node !== "object") return node;
		const out = {};
		for (const [k, v] of Object.entries(node)) {
			if (k === "files") {
				out.files = {};
				for (const [fk, fv] of Object.entries(v)) {
					out.files[fk.replace(/\\/g, "/")] = fix(fv);
				}
			} else {
				out[k] = fix(v);
			}
		}
		return out;
	};
	const newJson = Buffer.from(JSON.stringify(fix(header)), "utf8");
	const newPayload = (4 + newJson.length + 3) & ~3;
	const newHeaderBufLen = 4 + newPayload;
	const dataStart = 8 + headerBufLen;
	const newDataStart = 8 + newHeaderBufLen;
	const out = Buffer.alloc(newDataStart + (buf.length - dataStart));
	out.writeUInt32LE(4, 0);
	out.writeUInt32LE(newHeaderBufLen, 4);
	out.writeUInt32LE(newPayload, 8);
	out.writeUInt32LE(newJson.length, 12);
	newJson.copy(out, 16);
	buf.copy(out, newDataStart, dataStart);
	fs.writeFileSync(asarPath, out);
}
