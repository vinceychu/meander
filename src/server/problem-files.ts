/**
 * THE PROBLEM'S FILES — the workspace folder the learner works in
 * (2026-11-09).
 *
 * The folder is the ONE workspace: the in-app editor, the Run pane, the
 * grader and VS Code all read and write the same directory, so switching
 * modes never loses work.
 *
 * A course that hands its lab out in a SUBFOLDER (CS61A's "lab01/") keeps
 * its code there, so the editor reads and writes the nested names
 * ("lab01/lab01.py") — the learner's solution is reachable in the app, not
 * only in VS Code.
 *
 * A name may point INTO the folder, never out of it: "..", an absolute
 * path, a hidden folder or a link that leaves the folder is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** How deep the editor looks (a course that nests its lab is rare). */
const MAX_DEPTH = 4;

/** How many files the editor lists (a course's vendored suite is not the
 *  learner's work, and the editor is not a file browser). */
const MAX_FILES = 200;

/** The folders the editor never walks into. */
const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__", "vendor", "target"]);

/** The files the editor never shows (images, archives, binaries). */
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".tiff",
	".ico",
	".svgz",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".tar",
	".jar",
	".class",
	".so",
	".dylib",
	".dll",
	".exe",
	".pyc",
	".pyo",
	".o",
	".a",
	".mp3",
	".mp4",
	".mov",
	".avi",
	".webm",
	".wasm",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
]);

/** The biggest file the editor loads (bigger ones are not source). */
const MAX_FILE_BYTES = 256 * 1024;

/** The files of a prepared folder (for the in-app editor). */
export function readProblemFiles(folder: string): Array<{ name: string; content: string; language: string }> {
	const out: Array<{ name: string; content: string; language: string }> = [];
	const walk = (dir: string, prefix: string, depth: number): void => {
		if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (out.length >= MAX_FILES) return;
			// Hidden files and folders are the course's own tooling, not the
			// learner's code.
			if (entry.name.startsWith(".")) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_FOLDERS.has(entry.name)) continue;
				walk(full, `${prefix}${entry.name}/`, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
			let content: string;
			try {
				const stat = fs.statSync(full);
				if (stat.size > MAX_FILE_BYTES) continue;
				content = fs.readFileSync(full, "utf-8");
			} catch {
				continue;
			}
			const name = `${prefix}${entry.name}`;
			out.push({ name, content, language: languageOf(name) });
		}
	};
	walk(folder, "", 0);
	return out;
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

/**
 * The path a file name means inside a problem's folder.
 *
 * The name may name a file in a subfolder ("lab01/lab01.py" — a course
 * that hands its lab out in a folder), but it may NEVER climb out of it:
 * "..", an absolute path, a hidden folder, or a link that leaves the
 * folder is refused.
 */
export function safeProblemPath(folder: string, name: string): string {
	const raw = name.trim().replace(/\\/g, "/");
	if (!raw) throw new Error("Invalid file name.");
	if (raw.startsWith("/")) throw new Error("Invalid file name.");
	const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0) throw new Error("Invalid file name.");
	for (const segment of segments) {
		if (segment === "..") throw new Error("Invalid file name.");
		if (segment.startsWith(".")) throw new Error("Invalid file name.");
	}
	const root = path.resolve(folder);
	const target = path.resolve(root, segments.join(path.sep));
	if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Invalid file name.");
	return target;
}

/** Save one file of a problem's folder (the learner's edit). */
export function saveProblemFile(folder: string, name: string, content: string): void {
	const target = safeProblemPath(folder, name);
	const parent = path.dirname(target);
	fs.mkdirSync(parent, { recursive: true });
	// A folder that is really a link out of the problem's folder is
	// refused too: the write must land inside the workspace.
	const root = path.resolve(folder);
	const rootReal = realPathOr(root);
	const parentReal = realPathOr(parent);
	if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
		throw new Error("Invalid file name.");
	}
	fs.writeFileSync(target, content, "utf-8");
}

/** A path with its links resolved (the path itself when it cannot be read). */
function realPathOr(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}
