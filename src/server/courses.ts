/**
 * COURSES — the server side (2026-11-09).
 *
 * Everything that touches the network or the filesystem for a course lives
 * here: fetching the syllabus (and caching it, so a course works offline
 * after the first fetch), preparing a problem's workspace, running the
 * learner's code, and handing the problem to VS Code.
 *
 * The pure half is core/courses.ts (the model) and core/course-parse.ts
 * (the parsers); the persistence is store/courses.ts.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	condenseNotes,
	htmlToMarkdown,
	parseProblemSetPage,
	parseSpecPage,
	parseSrtTimeline,
	parseUnitIndex,
	parseUnitPage,
	type TimelineEntry,
} from "../core/course-parse.ts";
import {
	courseIdFor,
	defaultCourseSettings,
	type ChatBinding,
	type Course,
	type CourseFile,
	type CourseProblem,
	type CourseService,
	type CourseUnit,
	type CourseVideoSegment,
} from "../core/courses.ts";
import { sandboxedCommand } from "../core/cli-tools.ts";
import { ensureDefaultCliTools } from "./cli-tools.ts";
import { effectiveSettings } from "./stores.ts";
import {
	bindChat,
	cachedPageIndex,
	chatBinding,
	courseDir,
	deleteCourse,
	listCourses,
	listCourseIds,
	readCachedPage,
	readCourse,
	readProgress,
	updateProgress,
	writeCachedPage,
	writeCourse,
	writeProgress,
} from "../store/courses.ts";

// ─── the course catalogue ───────────────────────────────────────────────────

/** One course the app knows how to fetch. */
export interface CourseDefinition {
	/** The stable id ("cs50x"). */
	id: string;
	/** The display title. */
	title: string;
	/** Where the course lives (its site). */
	source: string;
	/** The edition label ("2026"). */
	edition?: string;
	/** The page that lists the course's units. */
	indexUrl: string;
	/** A one-line description of what the course is. */
	blurb: string;
}

/** The courses the app ships with. A course is data, not code: adding one
 *  is a new entry here, not a new module. */
export const COURSE_CATALOG: CourseDefinition[] = [
	{
		id: "cs50x",
		title: "CS50x",
		source: "https://cs50.harvard.edu/x/",
		edition: "2026",
		indexUrl: "https://cs50.harvard.edu/x/weeks/",
		blurb: "Harvard's introduction to the intellectual enterprises of computer science — C, arrays, algorithms, memory, data structures, Python, HTTP and the web.",
	},
];

/** One catalogue entry (null when the id is unknown). */
export function courseDefinition(id: string): CourseDefinition | null {
	return COURSE_CATALOG.find((c) => c.id === id) ?? null;
}

// ─── fetching (cached) ──────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 30_000;

/** Fetch a page and cache it under the course's folder.
 *
 *  The cache is the offline story: the syllabus, the notes and the problem
 *  specs are re-readable from disk with no network, so a course keeps
 *  working when the site is down (or the machine is offline). */
export async function fetchPage(courseId: string, url: string): Promise<string> {
	const cached = readCachedPage(courseId, url);
	if (cached !== null) return cached;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "Meander (course fetch)" },
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
		const html = await response.text();
		writeCachedPage(courseId, url, html);
		return html;
	} finally {
		clearTimeout(timer);
	}
}

/** The cached page for a URL, or null. */
export function cachedPage(courseId: string, url: string): string | null {
	return readCachedPage(courseId, url);
}

/** How many pages are cached for a course (diagnostics). */
export function cachedPageCount(courseId: string): number {
	return Object.keys(cachedPageIndex(courseId)).length;
}

// ─── building the course ────────────────────────────────────────────────────

/** The unit id: a slug of the unit's own title ("Week 1 C" → "week-1-c"). */
function unitId(title: string, fallback: string): string {
	const slug = title
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

/** The problem id: a slug of the spec path ("mario/less" → "mario-less"). */
function problemIdFromPath(specUrl: string, title: string): string {
	let path = specUrl;
	try {
		const url = new URL(specUrl);
		const parts = url.pathname.split("/").filter(Boolean);
		const psets = parts.findIndex((p) => p === "psets");
		path = psets >= 0 ? parts.slice(psets + 2).join("/") : parts.slice(-2).join("/");
	} catch {
		/* fall through to the title */
	}
	const slug = path
		.split("/")
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || courseIdFor(title);
}

/** The starter files a problem gets: the spec's own starter code (when it
 *  ships one), a Makefile for C, and the spec as the README. */
export function starterFiles(problem: {
	fileName?: string | null;
	language: string;
	starterCode?: string;
	taskMarkdown: string;
}): CourseFile[] {
	const files: CourseFile[] = [];
	const name = problem.fileName ?? (problem.language === "python" ? "main.py" : problem.language === "sql" ? "main.sql" : "main.txt");
	if (problem.starterCode) {
		files.push({ name, content: problem.starterCode, language: problem.language });
	}
	if (problem.language === "c") {
		const target = name.replace(/\.c$/, "");
		files.push({
			name: "Makefile",
			language: "text",
			content: [
				`CC = gcc`,
				`CFLAGS = -Wall -Wextra -std=c11 -O2 -ggdb3 -fno-common`,
				`LDLIBS = -lcs50 -lm`,
				``,
				`${target}: ${name}`,
				`\t$(CC) $(CFLAGS) -o ${target} ${name} $(LDLIBS)`,
				``,
				`clean:`,
				`\trm -f ${target}`,
				``,
			].join("\n"),
		});
	}
	files.push({
		name: "README.md",
		language: "text",
		content: `# ${problem.fileName ?? "The problem"}\n\n${problem.taskMarkdown}\n`,
	});
	return files;
}

/** Build (or rebuild) a course's plan from its source pages.
 *
 *  The result is the SKELETON: the units, their notes links, their
 *  problems (with their check50 slugs) and a condensed lesson built from
 *  the notes. The tutor then rewrites the lessons, picks the problems and
 *  the video segments — the tool never invents a timestamp.
 */
export async function buildCourse(courseId: string): Promise<Course> {
	const definition = courseDefinition(courseId);
	if (!definition) throw new Error(`Unknown course: ${courseId}`);
	const indexHtml = await fetchPage(courseId, definition.indexUrl);
	const entries = parseUnitIndex(indexHtml, definition.indexUrl);
	const units: CourseUnit[] = [];
	for (const [index, entry] of entries.entries()) {
		const html = await fetchPage(courseId, entry.url);
		const page = parseUnitPage(html, entry.url);
		const id = unitId(page.title || entry.title, `unit-${index + 1}`);
		let notes = "";
		if (page.notesUrl) {
			try {
				const notesHtml = await fetchPage(courseId, page.notesUrl);
				notes = htmlToMarkdown(notesHtml);
			} catch {
				notes = "";
			}
		}
		const problems: CourseProblem[] = [];
		if (page.psetUrl) {
			try {
				const psetHtml = await fetchPage(courseId, page.psetUrl);
				for (const link of parseProblemSetPage(psetHtml, page.psetUrl)) {
					let spec;
					try {
						const specHtml = await fetchPage(courseId, link.specUrl);
						spec = parseSpecPage(specHtml, link.specUrl);
					} catch {
						continue; // a spec that will not fetch is skipped, not faked
					}
					const language = spec.language;
					problems.push({
						id: problemIdFromPath(link.specUrl, spec.title || link.title),
						unitId: id,
						title: spec.title || link.title,
						slug: spec.slug ?? "",
						specUrl: link.specUrl,
						variant: link.variant,
						language,
						distributionUrls: spec.distributionUrls,
						...(spec.videoEmbeds.length > 0 ? { videoEmbeds: spec.videoEmbeds } : {}),
						files: starterFiles({
							fileName: spec.fileName,
							language,
							...(spec.starterCode ? { starterCode: spec.starterCode } : {}),
							taskMarkdown: spec.taskMarkdown,
						}),
						estimateMinutes: 45,
					});
				}
			} catch {
				/* no pset for this unit — fine */
			}
		}
		units.push({
			id,
			index,
			title: page.title || entry.title,
			summary: page.summary,
			notesUrl: page.notesUrl,
			pageUrl: entry.url,
			...(page.videoId ? { videoId: page.videoId } : {}),
			lesson: notes ? condenseNotes(notes) : "",
			videos: [],
			estimateMinutes: 60,
			problems,
		});
	}
	const now = new Date().toISOString();
	const existing = readCourse(courseId);
	return writeCourse({
		id: courseId,
		title: definition.title,
		source: definition.source,
		...(definition.edition ? { edition: definition.edition } : {}),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		settings: existing?.settings ?? defaultCourseSettings(),
		units,
	});
}

/** The course record (null when it does not exist). */
export function getCourse(courseId: string): Course | null {
	return readCourse(courseId);
}

/** Every course on disk. */
export function allCourses(): Course[] {
	return listCourses();
}

/** The course ids on disk. */
export function allCourseIds(): string[] {
	return listCourseIds();
}

/** Write the course record. */
export function saveCourse(course: Course): Course {
	return writeCourse(course);
}

/** Delete a course (plan, progress and cached pages). */
export function removeCourse(courseId: string): void {
	deleteCourse(courseId);
}

/** The unit's notes markdown (from the cache — no network needed once fetched). */
export async function unitNotes(courseId: string, unit: CourseUnit): Promise<string> {
	if (!unit.notesUrl) return "";
	const html = await fetchPage(courseId, unit.notesUrl);
	return htmlToMarkdown(html);
}

/** The lecture's sampled timeline — the REAL timestamps a video segment
 *  may point at. Read from the lecture's own subtitle track, so a segment
 *  can never point at a moment that does not exist. */
export async function unitTimeline(courseId: string, unit: CourseUnit): Promise<TimelineEntry[]> {
	const page = await unitPage(courseId, unit);
	if (!page?.subtitlesUrl) return [];
	try {
		const response = await fetch(page.subtitlesUrl);
		if (!response.ok) return [];
		const srt = await response.text();
		writeCachedPage(courseId, page.subtitlesUrl, srt);
		return parseSrtTimeline(srt, { stepSeconds: 30, maxEntries: 120 });
	} catch {
		return [];
	}
}

/** The unit's source page (re-parsed from the cache). */
async function unitPage(courseId: string, unit: CourseUnit) {
	if (!unit.pageUrl) return null;
	const html = await fetchPage(courseId, unit.pageUrl);
	return parseUnitPage(html, unit.pageUrl);
}

// ─── the workspace ──────────────────────────────────────────────────────────

/** The workspace root: where the problem folders live. */
export function workspaceRoot(): string {
	const configured = effectiveSettings().courses.workspaceRoot;
	const raw = configured?.trim() || "~/cs50";
	const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.resolve(expanded);
}

/** One problem's folder inside the workspace (the spec's default layout:
 *  the workspace root is ~/cs50, so a problem lives in ~/cs50/<problem>). */
export function problemFolder(courseId: string, problemId: string): string {
	return path.join(workspaceRoot(), problemId);
}

/** The workspace catalogue the cs50 tool reads (the tool is deliberately
 *  dumb: it reads this, creates folders and shells out to check50). */
export function writeCatalogue(course: Course): string {
	const root = workspaceRoot();
	fs.mkdirSync(root, { recursive: true });
	const problems = course.units.flatMap((unit) =>
		unit.problems.map((problem) => ({
			id: problem.id,
			title: problem.title,
			slug: problem.slug,
			specUrl: problem.specUrl,
			language: problem.language,
			file: problem.files.find((f) => f.name !== "README.md" && f.name !== "Makefile")?.name ?? "",
			folder: problem.id,
			readme: problem.files.find((f) => f.name === "README.md")?.content ?? "",
			files: Object.fromEntries(problem.files.map((f) => [f.name, f.content])),
		})),
	);
	const file = path.join(root, "catalogue.json");
	fs.writeFileSync(
		file,
		JSON.stringify({ courseId: course.id, courseTitle: course.title, workspaceRoot: workspaceRoot(), problems }, null, "\t"),
		"utf-8",
	);
	return file;
}

/** Prepare a problem's folder: the starter files (never overwriting the
 *  learner's work) and the workspace catalogue. */
export function prepareProblem(course: Course, problem: CourseProblem): { folder: string; created: string[] } {
	const folder = problemFolder(course.id, problem.id);
	fs.mkdirSync(folder, { recursive: true });
	const created: string[] = [];
	for (const file of problem.files) {
		const target = path.join(folder, file.name);
		if (fs.existsSync(target)) continue;
		fs.writeFileSync(target, file.content, "utf-8");
		created.push(file.name);
	}
	writeCatalogue(course);
	return { folder, created };
}

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
	if (name.endsWith(".py")) return "python";
	if (name.endsWith(".sql")) return "sql";
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

// ─── running ────────────────────────────────────────────────────────────────

/** The toolchain environment (the env file the setup script writes). */
export function toolchainEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const file = path.join(os.homedir(), ".config", "meander", "cs50", "env");
	try {
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			const trimmed = line.trim().replace(/^export\s+/, "");
			if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
			const index = trimmed.indexOf("=");
			const key = trimmed.slice(0, index).trim();
			let value = trimmed.slice(index + 1).trim();
			if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
				value = value.slice(1, -1);
			}
			value = value.replace(/\$HOME/g, os.homedir()).replace(/\$\{HOME\}/g, os.homedir());
			if (key === "PATH") {
				// PATH entries are PREPENDED, never a replacement: the
				// learner's own PATH must survive the toolchain's.
				const existing = env.PATH ?? "";
				env.PATH = existing ? `${value}:${existing}` : value;
				continue;
			}
			env[key] = value;
		}
	} catch {
		/* no env file — the plain environment is used */
	}
	const shim = path.join(os.homedir(), ".local", "share", "meander", "cs50", "bin");
	env.PATH = `${shim}:${path.join(os.homedir(), ".local", "bin")}:${env.PATH ?? ""}`;
	return env;
}

/** The result of a run. */
export interface RunResult {
	ok: boolean;
	/** The combined output (stdout + stderr). */
	output: string;
	/** The command that ran. */
	command: string;
}

/** The sample input the Run pane feeds a program that asks for something
 *  (a height, a name). The grader — not this — decides whether the
 *  program is right; the Run pane only shows that it builds and starts. */
const SAMPLE_INPUT = "8\n";

/** Run a command inside the CLI sandbox (bubblewrap on Linux, sandbox-exec
 *  on macOS) — the learner's code never runs with the server's full
 *  permissions. A missing sandbox is reported, never bypassed. */
export function runSandboxed(
	command: string,
	args: string[],
	opts: { cwd: string; writable?: string[]; timeoutMs?: number; input?: string; keepStdinOpen?: boolean },
): Promise<RunResult> {
	const writable = opts.writable ?? [opts.cwd];
	const plan = sandboxedCommand(process.platform, command, args, { writable, cwd: opts.cwd });
	if ("unavailable" in plan) {
		return Promise.resolve({
			ok: false,
			output: `not run: ${plan.unavailable}. The learner's code runs sandboxed — install bubblewrap on Linux, or run the problem in VS Code instead.`,
			command: `${command} ${args.join(" ")}`.trim(),
		});
	}
	return new Promise((resolve) => {
		const child = execFile(
			plan.command,
			plan.args,
			{
				cwd: opts.cwd,
				env: toolchainEnv(),
				timeout: opts.timeoutMs ?? 60_000,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const status = !err
					? "exit code 0"
					: err.killed
						? "killed after the timeout"
						: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "the program printed more than the output buffer holds"
							: typeof err.code === "number"
								? `exit code ${err.code}`
								: `failed to start: ${err.message}`;
				const parts = [status];
				if (stdout) parts.push(stdout.trimEnd());
				if (stderr) parts.push(stderr.trimEnd());
				resolve({
					ok: !err,
					output: parts.join("\n"),
					command: `${command} ${args.join(" ")}`.trim(),
				});
			},
		);
		child.stdin?.on("error", () => {});
		if (opts.keepStdinOpen) {
			// The pipe stays OPEN: a program that asks for input gets the
			// sample, and a program that asks again waits (the timeout stops
			// it) instead of looping on the end of the file.
			if (opts.input !== undefined) child.stdin?.write(opts.input);
		} else if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		} else {
			child.stdin?.end();
		}
	});
}

/** The run step of a problem: build it, then run it.
 *
 *  C → `make` then the binary; Python → `python3 <file>`; SQL →
 *  `sqlite3 :memory:` with the file on stdin. A missing toolchain is
 *  reported honestly, never faked. */
export async function runProblem(course: Course, problem: CourseProblem): Promise<RunResult> {
	const folder = problemFolder(course.id, problem.id);
	if (!fs.existsSync(folder)) {
		return { ok: false, output: "The problem's files are not set up yet — open the problem first.", command: "" };
	}
	if (problem.language === "c") {
		const target = (problem.files.find((f) => f.name.endsWith(".c"))?.name ?? "main").replace(/\.c$/, "");
		const build = await runSandboxed("make", [], { cwd: folder, writable: [folder] });
		if (!build.ok) return { ...build, command: `make (${target})` };
		const run = await runSandboxed(`./${target}`, [], {
			cwd: folder,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
		return { ...run, output: `${build.output}\n${run.output}`, command: `make && ./${target}` };
	}
	if (problem.language === "python") {
		const file = problem.files.find((f) => f.name.endsWith(".py"))?.name ?? "main.py";
		return runSandboxed("python3", [file], {
			cwd: folder,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
	}
	if (problem.language === "sql") {
		const file = problem.files.find((f) => f.name.endsWith(".sql"))?.name ?? "main.sql";
		const sql = fs.readFileSync(path.join(folder, file), "utf-8");
		const result = await runSandboxed("sqlite3", [":memory:"], { cwd: folder, writable: [folder], timeoutMs: 20_000, input: sql });
		if (!result.ok && /failed to start|ENOENT/i.test(result.output)) {
			return {
				ok: false,
				output: "sqlite3 is not installed on this machine — install it, or work on the problem in VS Code.",
				command: "sqlite3 :memory:",
			};
		}
		return result;
	}
	return { ok: false, output: "This problem has nothing to run — read its spec and answer in the chat.", command: "" };
}

// ─── VS Code ────────────────────────────────────────────────────────────────

/** The links that open a folder in VS Code: the local one and the remote
 *  one (the machine the server runs on, over SSH). */
export function vscodeLinks(folder: string): { local: string; remote: string } {
	const host = effectiveSettings().courses.vscodeHost || "5090v1";
	return {
		local: `vscode://file/${folder}`,
		remote: `vscode://vscode-remote/ssh-remote+${host}${folder}`,
	};
}

// ─── the grader (the cs50 learner tool) ─────────────────────────────────────

/** The cs50 tool's script (the tools dir copy the app installs). */
export function cs50ToolScript(): string | null {
	// The shipped tools land in the tools dir on first use — the grader is
	// part of the app, not something the learner has to install by hand.
	ensureDefaultCliTools();
	const file = path.join(PATHS.tools, "cs50-tool.py");
	try {
		return fs.existsSync(file) ? file : null;
	} catch {
		return null;
	}
}

/** Run one cs50 subcommand ("check mario-less") through the learner tool.
 *
 *  The tool is the single implementation of the grading path — the agent
 *  calls it as `cli_cs50` and the app's Check button calls it here, so the
 *  two can never drift. The tool itself never submits anything. */
export async function runCs50Tool(command: string): Promise<{ ok: boolean; output: string }> {
	const script = cs50ToolScript();
	if (!script) {
		return {
			ok: false,
			output:
				"The cs50 grader is not installed yet — run the cs50 tool's 'setup' subcommand (no sudo), " +
				"or install it from the app's learner-tools folder.",
		};
	}
	return new Promise((resolve) => {
		const child = execFile(
			"python3",
			[script],
			{
				cwd: path.dirname(script),
				env: { ...toolchainEnv(), LH_WORKSPACE_ROOT: workspaceRoot() },
				timeout: 600_000,
				maxBuffer: 8 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const parts: string[] = [];
				if (stdout?.trim()) parts.push(stdout.trimEnd());
				if (stderr?.trim()) parts.push(stderr.trimEnd());
				resolve({ ok: !error, output: parts.join("\n") || "(no output)" });
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	});
}

/** What the grader's output says about the work. */
export interface CheckVerdict {
	/** The checks that ran. */
	total: number;
	/** The checks that passed. */
	passed: number;
	/** The failing checks' names. */
	failed: string[];
}

/** Read the grader's [ok]/[FAIL] lines into a verdict.
 *
 *  The lines are the cs50 tool's own format ("[ok] compiles",
 *  "[FAIL] rejects a height of 0" and a "3/10 checks passed" summary) —
 *  the same text the tutor coaches from, so the app and the tutor read
 *  one thing. A run that produced no lines at all (the grader is missing,
 *  the program does not compile) is no verdict — the caller keeps the old
 *  status rather than marking the problem done. */
export function parseCheckOutput(output: string): CheckVerdict {
	const lines = output.split("\n");
	const failed: string[] = [];
	let ok = 0;
	for (const line of lines) {
		const match = /^\[(ok|FAIL)\]\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		if (match[1] === "ok") ok++;
		else failed.push((match[2] ?? "").trim());
	}
	const summary = /(\d+)\/(\d+) checks passed/.exec(output);
	const total = summary ? Number(summary[2]) : ok + failed.length;
	const passed = summary ? Number(summary[1]) : ok;
	return { total, passed, failed };
}

export { readProgress, writeProgress, updateProgress, courseDir };
// The chat bindings (which course each session is about) — the routes
// bind a session to its course at creation.
export { bindChat, chatBinding };

// ─── the service (the agent tool's seam) ────────────────────────────────────

/**
 * THE COURSE SERVICE — the one object the agent layer is allowed to talk to.
 *
 * The agent may not import the server (the architecture law), so the
 * course tool receives this interface instead. Everything the tool needs —
 * the syllabus fetch, the notes, the timeline, the workspace, the progress
 * and the chat bindings — hangs off it.
 */
export const courseService: CourseService = {
	listCourses: allCourses,
	getCourse,
	buildCourse,
	unitNotes,
	unitTimeline,
	prepareProblem,
	problemFolder,
	readProgress,
	updateProgress,
	saveCourse,
	chatBinding,
	bindChat,
};
