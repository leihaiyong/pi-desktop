import path from "node:path";

/**
 * Pure helpers for browsing / managing extensions & skills.
 *
 * The pi SDK resolves every resource file and lets the user enable/disable it
 * by writing a `!<pattern>` into the matching settings array (`skills` or
 * `extensions`). `resourceTogglePattern` computes the pattern that pi's
 * resource matcher will match for a given file.
 */

/**
 * A pattern that pi's resource matcher (`matchesAnyPattern`) will match for
 * `filePath`. Returns a relative path (posix separators) when the file lives
 * under `baseDir`, otherwise the file / directory basename.
 *
 *  - skills: matched by their SKILL.md *directory* — the matcher considers the
 *    directory's relative path (`parentRel`) and basename (`parentName`), so a
 *    `!<dir>` pattern disables exactly that skill.
 *  - extensions: matched by the *file* path (`rel`) / basename.
 */
export function resourceTogglePattern(type, filePath, baseDir) {
	const file = String(filePath ?? "");
	const target = type === "skill" ? path.dirname(file) : file;
	if (baseDir) {
		const posix = path.relative(baseDir, target).replace(/\\/g, "/");
		if (posix && !posix.startsWith("..")) return posix;
	}
	return path.basename(target);
}
