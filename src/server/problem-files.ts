/**
 * THE PROBLEM'S FILES — the workspace folder the learner works in
 * (2026-11-09).
 *
 * The folder is the ONE workspace: the in-app editor, the Run pane, the
 * grader and VS Code all read and write the same directory, so switching
 * modes never loses work.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The files of a prepared folder (for the in-app editor). */
export function readProblemFiles(folder: string): Array<{ name: string; content: string; language: string }> {
	let entries: string[];
	try {
		entries = fs.readdirSync(folder);
	} catch {
		return [];
	}
	return entries
		.filter((name) => !name.startsWith("."))
		.map((name) => {
			const full = path.join(folder, name);
			try {
				const content = fs.readFileSync(full, "utf-8");
				return { name, content, language: languageOf(name) };
			} catch {
				return null;
			}
		})
		.filter((f): f is { name: string; content: string; language: string } => f !== null);
}

/** The editor's language for a file name. */
export function languageOf(name: string): string {
	if (name.endsWith(".c") || name.endsWith(".h")) return "c";
	if (name.endsWith(".cpp") || name.endsWith(".cc") || name.endsWith(".cxx") || name.endsWith(".hpp")) return "cpp";
	if (name.endsWith(".py")) return "python";
	if (name.endsWith(".sql")) return "sql";
	if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs") || name.endsWith(".jsx")) return "javascript";
	if (name.endsWith(".ts") || name.endsWith(".tsx")) return "typescript";
	if (name.endsWith(".go")) return "go";
	if (name.endsWith(".rs")) return "rust";
	if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
	if (name.endsWith(".json")) return "json";
	if (name.endsWith(".md")) return "text";
	return "text";
}

/** Save one file of a problem's folder (the learner's edit). */
export function saveProblemFile(folder: string, name: string, content: string): void {
	const safe = path.basename(name);
	if (!safe || safe.startsWith(".")) throw new Error("Invalid file name.");
	const target = path.join(folder, safe);
	if (!target.startsWith(path.resolve(folder) + path.sep) && path.resolve(target) !== path.resolve(folder)) {
		throw new Error("Invalid file name.");
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf-8");
}
