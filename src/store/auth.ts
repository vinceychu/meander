/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). This adapter persists what it is given, never throws
 * (absent/corrupt file = {} = "no keys yet", the documented first-boot
 * state, matching settings doctrine), and preserves unknown vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";

/** A second copy of the keys beside auth.json: if auth.json ever goes
 *  missing or corrupt (a bad hand-edit, a half-finished copy), the keys
 *  come back from here instead of looking like "no keys yet". */
const BACKUP_FILE = () => path.join(path.dirname(AUTH_FILE), "auth.backup.json");

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	return readFile(AUTH_FILE) ?? readFile(BACKUP_FILE()) ?? {};
}

function readFile(file: string): Record<string, string> | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return null; // absent or corrupt
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  tmp-in-same-dir + rename keeps the swap atomic; chmod BEFORE the
 *  rename so the mode never exists relaxed on the final path. */
function writeMap(map: Record<string, string>): void {
	writeFile(AUTH_FILE, map);
	try {
		writeFile(BACKUP_FILE(), map);
	} catch {
		/* the backup is best effort; auth.json is already saved */
	}
}

function writeFile(file: string, map: Record<string, string>): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600); // umask may have relaxed the create mode
	fs.renameSync(tmp, file);
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};
