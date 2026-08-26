import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionsDir, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (fs.existsSync(dst)) {
				logger.warn("Session directory migration collision; preserving legacy entry", { src, dst });
				continue;
			}
			fs.renameSync(src, dst);
		}
		fs.rmdirSync(oldPath);
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/**
 * Reconstruct the short-lived hashed session dir name used by 17.2.5-17.2.8
 * (reverted PR #7397): `<scope>-<readable>-<sha256hex>` keyed by the canonical
 * cwd. Kept only so {@link migrateHashedSessionDir} can recover sessions
 * stranded when 17.2.9 restored the legacy names without a reverse migration.
 */
function encodeHashedSessionDirName(canonicalCwd: string, scope: "home" | "tmp" | "abs"): string {
	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	return `${scope}-${readable || "project"}-${digest}`;
}

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	hashedDirName: string;
	resolvedCwd: string;
} {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	let encodedDirName: string;
	let scope: "home" | "tmp" | "abs";
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-", homeRelative);
		scope = "home";
	} else if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
		scope = "tmp";
	} else {
		encodedDirName = encodeLegacyAbsoluteSessionDirName(canonicalCwd);
		scope = "abs";
	}
	return { encodedDirName, hashedDirName: encodeHashedSessionDirName(canonicalCwd, scope), resolvedCwd };
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			logger.warn("Failed to migrate legacy home session directory", {
				oldPath,
				newPath,
				error: String(error),
			});
		}
	}
}

function migrateLegacyAbsoluteSessionDir(cwd: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(cwd));
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate legacy session directory", {
			oldPath: legacyDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

/**
 * Migrate a 17.2.5-17.2.8 hashed session dir back into its legacy path-based
 * directory. The 17.2.9 revert restored the legacy names but dropped migration,
 * stranding sessions written under the hashed scheme (issue #7677). Best-effort.
 */
function migrateHashedSessionDir(hashedDirName: string, sessionDir: string, sessionsRoot: string): void {
	const hashedDir = path.join(sessionsRoot, hashedDirName);
	if (hashedDir === sessionDir || !fs.existsSync(hashedDir)) return;

	try {
		migrateSessionDirPath(hashedDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate hashed session directory", {
			oldPath: hashedDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	if (currentDirName !== encodedDirName && currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const { encodedDirName, hashedDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	migrateLegacyAbsoluteSessionDir(resolvedCwd, sessionDir, sessionsRoot);
	migrateHashedSessionDir(hashedDirName, sessionDir, sessionsRoot);
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}
