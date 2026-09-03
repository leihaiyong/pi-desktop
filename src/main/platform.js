/**
 * Platform-specific shell configuration used for display and bash execution.
 * Mirrors the TUI behavior of using PowerShell on Windows and a POSIX shell
 * elsewhere.
 */
export function shellConfigForPlatform(platform) {
	if (platform === "win32") {
		return {
			name: "powershell",
			bin: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"],
			separator: "\r\n",
			label: "Windows (PowerShell)",
		};
	}
	if (platform === "darwin") {
		return { name: "bash", bin: "bash", args: ["-c"], separator: "\n", label: "macOS (bash)" };
	}
	return { name: "bash", bin: "bash", args: ["-c"], separator: "\n", label: "Linux (bash)" };
}

export function isWindows(platform = process.platform) {
	return platform === "win32";
}
