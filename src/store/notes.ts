/**
 * NOTES VAULT ADAPTER (2026-11-06): a folder of plain files — Markdown
 * notes, .base views, attachments — readable by Obsidian and any editor.
 * Every path the app hands in is vault-relative and cleaned
 * (core/notes.ts cleanNotePath); this module re-checks containment after
 * resolving symlinks so nothing escapes the vault root.
 *
 * Default root: <data>/notes (syncs with the data folder). notes-vault.json
 * can point it elsewhere — an existing Obsidian vault, a Syncthing folder.
 * Deletes go to <vault>/.trash (Obsidian's "move to vault trash").
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { cleanNotePath, type VaultFile } from "../core/notes.ts";

export class NotesPathError extends Error {}
export class NotesConflictError extends Error {
	constructor(public readonly mtime: number) {
		super("The note changed on disk since it was opened.");
	}
}

interface VaultConfig {
	path?: string;
}

function readConfig(): VaultConfig {
	try {
		const v = JSON.parse(fs.readFileSync(PATHS.notesVaultConfig, "utf8")) as VaultConfig;
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function vaultRoot(): string {
	const configured = readConfig().path;
	const root = configured ? path.resolve(expandHome(configured)) : PATHS.notes;
	fs.mkdirSync(root, { recursive: true });
	return root;
}

export function vaultInfo(): { root: string; custom: boolean; defaultRoot: string } {
	const configured = readConfig().path;
	return { root: vaultRoot(), custom: !!configured, defaultRoot: PATHS.notes };
}

/** Point the app at another folder (null = back to the default). */
export function setVaultRoot(folder: string | null): string {
	if (folder === null || folder.trim() === "") {
		fs.rmSync(PATHS.notesVaultConfig, { force: true });
		return vaultRoot();
	}
	const abs = path.resolve(expandHome(folder.trim()));
	if (!path.isAbsolute(abs)) throw new NotesPathError("Use an absolute folder path.");
	const st = fs.statSync(abs, { throwIfNoEntry: false });
	if (st && !st.isDirectory()) throw new NotesPathError("That path is a file, not a folder.");
	fs.mkdirSync(abs, { recursive: true });
	fs.mkdirSync(path.dirname(PATHS.notesVaultConfig), { recursive: true });
	writeFileAtomicSync(PATHS.notesVaultConfig, JSON.stringify({ path: abs }, null, 2));
	return abs;
}

/** Vault-relative → absolute, refusing anything outside the root. */
export function resolveInVault(rel: string): string {
	const clean = cleanNotePath(rel);
	if (!clean) throw new NotesPathError("Invalid note path.");
	const root = vaultRoot();
	const abs = path.resolve(root, clean);
	const realRoot = fs.realpathSync(root);
	// Resolve the deepest existing ancestor (the target may not exist yet).
	let probe = abs;
	while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
	const realProbe = fs.realpathSync(probe);
	if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new NotesPathError("Path escapes the vault.");
	return abs;
}

const SKIP_DIRS = new Set(["node_modules"]);

/** Every visible file in the vault (hidden names, temp files skipped). */
export function listVault(): { files: VaultFile[]; folders: string[] } {
	const root = vaultRoot();
	const files: VaultFile[] = [];
	const folders: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (depth > 24) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") || e.name.includes(".tmp-") || SKIP_DIRS.has(e.name)) continue;
			const abs = path.join(dir, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				folders.push(r);
				walk(abs, r, depth + 1);
			} else if (e.isFile()) {
				try {
					const st = fs.statSync(abs);
					files.push({ path: r, size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.birthtimeMs || st.ctimeMs) });
				} catch {
					/* vanished mid-walk */
				}
			}
		}
	};
	walk(root, "", 0);
	return { files, folders };
}

export function statNote(rel: string): { mtime: number; size: number } | null {
	const st = fs.statSync(resolveInVault(rel), { throwIfNoEntry: false });
	return st && st.isFile() ? { mtime: Math.round(st.mtimeMs), size: st.size } : null;
}

export function readText(rel: string): string | null {
	try {
		return fs.readFileSync(resolveInVault(rel), "utf8");
	} catch {
		return null;
	}
}

export function readBinary(rel: string): Buffer | null {
	try {
		return fs.readFileSync(resolveInVault(rel));
	} catch {
		return null;
	}
}

/** Save a note. `baseMtime` (the mtime the editor loaded) guards against
 *  silently overwriting a newer copy from another device or app. */
export function writeText(rel: string, text: string, opts: { baseMtime?: number; create?: boolean } = {}): number {
	const abs = resolveInVault(rel);
	const st = fs.statSync(abs, { throwIfNoEntry: false });
	if (opts.create && st) throw new NotesPathError("A file with that name already exists.");
	if (st && opts.baseMtime !== undefined && Math.abs(Math.round(st.mtimeMs) - opts.baseMtime) > 1) {
		const current = fs.readFileSync(abs, "utf8");
		if (current !== text) throw new NotesConflictError(Math.round(st.mtimeMs));
	}
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	writeFileAtomicSync(abs, text);
	return Math.round(fs.statSync(abs).mtimeMs);
}

export function writeBinary(rel: string, data: Uint8Array): void {
	const abs = resolveInVault(rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, data, { flag: "wx" });
}

export function exists(rel: string): boolean {
	try {
		return fs.existsSync(resolveInVault(rel));
	} catch {
		return false;
	}
}

export function makeFolder(rel: string): void {
	fs.mkdirSync(resolveInVault(rel), { recursive: true });
}

export function moveEntry(from: string, to: string): void {
	const a = resolveInVault(from);
	const b = resolveInVault(to);
	if (!fs.existsSync(a)) throw new NotesPathError("Nothing to move.");
	if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw new NotesPathError("Something with that name already exists.");
	fs.mkdirSync(path.dirname(b), { recursive: true });
	fs.renameSync(a, b);
}

/** Move a file or folder into <vault>/.trash (kept, like Obsidian). */
export function trashEntry(rel: string): void {
	const abs = resolveInVault(rel);
	if (!fs.existsSync(abs)) return;
	const trash = path.join(vaultRoot(), ".trash");
	fs.mkdirSync(trash, { recursive: true });
	const base = path.basename(abs);
	let dest = path.join(trash, base);
	for (let i = 1; fs.existsSync(dest); i++) {
		const ext = path.extname(base);
		dest = path.join(trash, `${base.slice(0, base.length - ext.length)} ${i}${ext}`);
	}
	fs.renameSync(abs, dest);
}
