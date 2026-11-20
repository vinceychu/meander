/**
 * THE STARTER CODE — where a problem's files come from (2026-11-09).
 *
 * A course hands out its starter code in one of three ways:
 *
 *   1. IN THE SPEC   the spec page shows the first code block (CS50's
 *                    "here is the file you will write").
 *   2. AS AN ARCHIVE a zip or a tarball the spec names (the AI course's
 *                    projects, most CS50 web lessons).
 *   3. AS A REPO    a GitHub repository (CS61A's labs, for instance) —
 *                    cloned with `git clone --depth 1` into the problem's
 *                    folder.
 *
 * TWO LAWS, and they are the point of this module (2026-11-10):
 *
 *   1. NOTHING HERE OVERWRITES THE LEARNER'S WORK. An archive is unpacked
 *      into a THROWAWAY folder and only the files that are not there yet
 *      are copied over; a file the learner has written is never touched,
 *      not even byte for byte.
 *   2. NOTHING HERE DELETES THE LEARNER'S WORK. A clone that fails leaves
 *      the folder exactly as it was: the failed clone is thrown away, never
 *      the target.
 *
 * Both laws hold on EVERY prepare — and prepare runs on every view, every
 * save, every run and every check, so a prepare that overwrote a file
 * would wipe the learner's solution right before it is graded.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Run a command and capture its output (never throws on a non-zero exit). */
function run(command: string, args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd, timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
				const parts = [stdout?.trimEnd(), stderr?.trimEnd()].filter(Boolean);
				resolve({ ok: !err, output: parts.join("\n") });
			},
		);
	});
}

/**
 * Copy a tree into a folder — the files that are NOT there yet, only.
 *
 * A file that already exists is left exactly as it is: the learner's edit
 * wins over the starter code, always. Symlinks are not copied at all (a
 * link in an archive can point anywhere).
 *
 * Returns the names it created, relative to the target folder.
 */
export function copyMissingFiles(source: string, target: string, prefix = ""): string[] {
	const created: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(source, { withFileTypes: true });
	} catch {
		return created;
	}
	for (const entry of entries) {
		const from = path.join(source, entry.name);
		const to = path.join(target, entry.name);
		if (entry.isDirectory()) {
			try {
				fs.mkdirSync(to, { recursive: true });
			} catch {
				continue;
			}
			created.push(...copyMissingFiles(from, to, `${prefix}${entry.name}/`));
			continue;
		}
		if (!entry.isFile()) continue; // a symlink or a device: never copied
		if (fs.existsSync(to)) continue; // the learner's file wins — always
		try {
			fs.copyFileSync(from, to);
			created.push(`${prefix}${entry.name}`);
		} catch {
			/* a file that cannot be copied is skipped, not fatal */
		}
	}
	return created;
}

/**
 * Fetch and unpack a starter archive into the problem's folder.
 *
 * The archive is unpacked into a throwaway folder and only the files the
 * problem's folder does not have yet are copied over — so a second prepare
 * (which happens on every view, run and check) never replaces the
 * learner's work.
 *
 * Returns the names it created (empty when the archive could not be
 * fetched — never a fake file).
 */
export async function downloadDistribution(url: string, folder: string): Promise<string[]> {
	let response: Response;
	try {
		response = await fetch(url, { headers: { "User-Agent": "Meander (course fetch)" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	} catch {
		return [];
	}
	if (!response.ok) return [];
	// What the archive IS: the name the course gave it, or what the server
	// said it sent. ("application/gzip" is a TAR: "gzip" merely ends in
	// "zip" — a tarball must never be unpacked as a zip.)
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	const isZip = /\.zip(\?|$)/i.test(url) || /(^|[/+-])zip\b/.test(type) || type.includes("x-zip");
	const isTar = /\.tar\.gz(\?|$)|\.tgz(\?|$)/i.test(url) || type.includes("gzip") || type.includes("x-tar") || /(^|[/+-])tar\b/.test(type);
	if (!isZip && !isTar) return [];
	let buffer: Buffer;
	try {
		buffer = Buffer.from(await response.arrayBuffer());
	} catch {
		return [];
	}
	// The work folder holds the archive AND its unpacked copy: nothing is
	// ever unpacked into the learner's folder.
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "lh-starter-"));
	try {
		const archive = path.join(work, isZip ? "starter.zip" : "starter.tar.gz");
		fs.writeFileSync(archive, buffer);
		const unpacked = path.join(work, "unpacked");
		fs.mkdirSync(unpacked, { recursive: true });
		// The unpack happens in the throwaway folder, where overwriting
		// nothing matters.
		const result = isZip
			? await run("unzip", ["-o", "-q", archive, "-d", unpacked])
			: await run("tar", ["-xzf", archive, "-C", unpacked]);
		if (!result.ok) return [];
		fs.mkdirSync(folder, { recursive: true });
		return copyMissingFiles(unpacked, folder);
	} catch {
		return [];
	} finally {
		try {
			fs.rmSync(work, { recursive: true, force: true });
		} catch {
			/* the temp folder stays — harmless */
		}
	}
}

/**
 * Clone a starter repository into the problem's folder.
 *
 * The clone lands in its own subfolder when the folder already has content
 * (the learner's work is never disturbed); otherwise it lands directly in
 * the folder.
 *
 * A folder that already holds the clone is left ALONE: a second prepare
 * does not clone again, and — the law that matters — a failed clone never
 * deletes anything: only the throwaway folder the clone was made in is
 * removed.
 */
export async function cloneRepository(url: string, folder: string): Promise<string[]> {
	if (!/^(https?:\/\/|git@)/i.test(url)) return [];
	fs.mkdirSync(folder, { recursive: true });
	// The folder IS the clone (it has a .git of its own): nothing to do.
	if (fs.existsSync(path.join(folder, ".git"))) return [];
	const existing = fs.readdirSync(folder);
	const target = existing.length > 0 ? path.join(folder, "starter") : folder;
	// The clone is already there (a previous prepare put it there): the
	// learner's work lives in it — leave it alone.
	if (fs.existsSync(target) && fs.readdirSync(target).length > 0) return [];
	// The clone is made in a throwaway folder INSIDE the problem's folder
	// (so the move never crosses a filesystem) and only a successful clone
	// is moved into place.
	const work = fs.mkdtempSync(path.join(folder, ".meander-clone-"));
	try {
		const result = await run("git", ["clone", "--depth", "1", url, work]);
		if (!result.ok) return [];
		const entries = fs.readdirSync(work);
		// The clone's new home exists before anything moves into it (the
		// folder may be the problem's folder itself, or a "starter/" beside
		// the learner's files).
		fs.mkdirSync(target, { recursive: true });
		for (const entry of entries) {
			fs.renameSync(path.join(work, entry), path.join(target, entry));
		}
		return entries.map((entry) => (existing.length > 0 ? `starter/${entry}` : entry));
	} catch {
		return [];
	} finally {
		try {
			fs.rmSync(work, { recursive: true, force: true });
		} catch {
			/* the temp folder stays — harmless */
		}
	}
}
