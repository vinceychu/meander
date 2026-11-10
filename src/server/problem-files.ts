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
 * path, a hidden folder or a link (a folder or the file itself) is refused.
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
			// A link is never followed (entry.isFile() is false for one, and
			// the open refuses one that appeared since).
			const content = readNoFollow(full);
			if (content === null) continue;
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

/** Save one file of a problem's folder (the learner's edit).
 *
 *  A course's own repository is cloned into the folder as it is, links
 *  included — so a link anywhere on the way (a folder or the file itself)
 *  is refused, and the file is opened without following one. */
export function saveProblemFile(folder: string, name: string, content: string): void {
	const target = safeProblemPath(folder, name);
	const root = path.resolve(folder);
	refuseLinks(root, target);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// Checked again: the folders made just now are the app's own, but the
	// check is cheap and closes the gap between the first one and the write.
	refuseLinks(root, target);
	const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW, 0o644);
	try {
		fs.writeFileSync(fd, content, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Open without following a link (where the platform has the flag). */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Read one file without following a link (null when it is one, or unreadable). */
function readNoFollow(full: string): string | null {
	let fd: number;
	try {
		fd = fs.openSync(full, fs.constants.O_RDONLY | NO_FOLLOW);
	} catch {
		return null;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		return fs.readFileSync(fd, "utf-8");
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Refuse a path inside the folder if any part of it — a folder on the way
 * or the file itself — is a link. The parts that do not exist yet are
 * fine (they will be made as real folders).
 */
function refuseLinks(root: string, target: string): void {
	const relative = path.relative(root, target);
	let current = root;
	for (const segment of relative.split(path.sep)) {
		if (!segment) continue;
		current = path.join(current, segment);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch {
			return; // the rest of the path does not exist yet
		}
		if (stat.isSymbolicLink()) throw new Error("Invalid file name.");
	}
}
