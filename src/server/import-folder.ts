/**
 * LEARN A FOLDER — notes import (fork, 2026-10-27). Every text note under a
 * folder (recursively) runs through the same extraction pipeline as the
 * notes-import button (/api/graph/import), so the runs show in the dock's
 * status chips like any other.
 *
 * Two steps, because extraction spends model tokens: `folderNotes` lists
 * what WOULD be imported (the client confirms with the learner), then
 * `importFolder` starts the runs in the background and returns at once.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slotsConfigured } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";

export const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text", ".org", ".rst", ".tex"]);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv"]);

export interface FolderNotes {
	folder: string;
	files: string[];
	/** Too big, or past the file cap. */
	skipped: string[];
}

function resolveFolder(p: string): string {
	const expanded = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
	return path.resolve(expanded);
}

export function folderNotes(folderPath: string): FolderNotes {
	const folder = resolveFolder(folderPath);
	if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a folder: ${folder}`);
	const files: string[] = [];
	const skipped: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
			} else if (e.isFile() && NOTE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
				const size = fs.statSync(full, { throwIfNoEntry: false })?.size ?? 0;
				if (size === 0) continue;
				if (size > MAX_FILE_BYTES || files.length >= MAX_FILES) skipped.push(full);
				else files.push(full);
			}
		}
	};
	walk(folder, 0);
	return { folder, files, skipped };
}

export type ImportFolderResult =
	| { ok: true; folder: string; started: number; skipped: number }
	| { ok: false; code: "models_not_configured" | "not_a_folder" | "no_notes"; error: string };

/** Start one extraction run per note (3 at a time) and return immediately. */
export function importFolder(folderPath: string): ImportFolderResult {
	if (!slotsConfigured(readSettingsRecord()?.models)) {
		return { ok: false, code: "models_not_configured", error: "Pick your models in Settings before importing notes." };
	}
	let notes: FolderNotes;
	try {
		notes = folderNotes(folderPath);
	} catch (e) {
		return { ok: false, code: "not_a_folder", error: (e as Error).message };
	}
	if (notes.files.length === 0) return { ok: false, code: "no_notes", error: `No text notes in ${notes.folder}` };

	const queue = [...notes.files];
	for (let w = 0; w < Math.min(3, queue.length); w++) {
		void (async () => {
			for (;;) {
				const filePath = queue.shift();
				if (!filePath) return;
				try {
					await extraction.importNotes({ filePath, text: fs.readFileSync(filePath, "utf-8") });
				} catch (err) {
					console.error(`[import-folder] ${filePath} failed:`, err);
				}
			}
		})();
	}
	return { ok: true, folder: notes.folder, started: notes.files.length, skipped: notes.skipped.length };
}
