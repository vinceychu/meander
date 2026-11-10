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
 * Nothing here overwrites the learner's work: an archive is unpacked
 * beside the existing files, and a clone lands in a fresh subfolder when
 * the folder already has something in it.
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

/** The file names a folder gained (the top level only). */
function entriesOf(folder: string, before: Set<string>): string[] {
	try {
		return fs
			.readdirSync(folder, { withFileTypes: true })
			.map((entry) => entry.name)
			.filter((name) => !before.has(name));
	} catch {
		return [];
	}
}

/**
 * Fetch and unpack a starter archive into the problem's folder.
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
	const isZip = /\.zip(\?|$)/i.test(url) || (response.headers.get("content-type") ?? "").includes("zip");
	const isTar = /\.tar\.gz(\?|$)|\.tgz(\?|$)/i.test(url) || (response.headers.get("content-type") ?? "").includes("tar");
	if (!isZip && !isTar) return [];
	const buffer = Buffer.from(await response.arrayBuffer());
	fs.mkdirSync(folder, { recursive: true });
	const before = new Set(fs.readdirSync(folder));
	const tmp = path.join(os.tmpdir(), `lh-starter-${Date.now()}${isZip ? ".zip" : ".tar.gz"}`);
	try {
		fs.writeFileSync(tmp, buffer);
		const result = isZip
			? await run("unzip", ["-o", "-q", tmp, "-d", folder])
			: await run("tar", ["-xzf", tmp, "-C", folder]);
		if (!result.ok) return [];
		return entriesOf(folder, before);
	} catch {
		return [];
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* the temp file stays — harmless */
		}
	}
}

/**
 * Clone a starter repository into the problem's folder.
 *
 * The clone lands in its own subfolder when the folder already has
 * content (the learner's work is never disturbed); otherwise it lands
 * directly in the folder.
 */
export async function cloneRepository(url: string, folder: string): Promise<string[]> {
	if (!/^(https?:\/\/|git@)/i.test(url)) return [];
	fs.mkdirSync(folder, { recursive: true });
	const existing = fs.readdirSync(folder);
	const target = existing.length > 0 ? path.join(folder, "starter") : folder;
	try {
		fs.mkdirSync(target, { recursive: true });
	} catch {
		return [];
	}
	const result = await run("git", ["clone", "--depth", "1", url, target]);
	if (!result.ok) {
		try {
			fs.rmSync(target, { recursive: true, force: true });
		} catch {
			/* the empty folder stays — harmless */
		}
		return [];
	}
	return existing.length > 0 ? ["starter"] : entriesOf(folder, new Set());
}
