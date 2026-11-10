/**
 * COURSES — the server side (2026-11-09).
 *
 * Everything that touches the network or the filesystem for a course lives
 * here: resolving what the learner asked for, fetching the syllabus (and
 * caching it, so a course works offline after the first fetch), preparing
 * a problem's workspace, running the learner's code and grading it.
 *
 * The course itself is an ADAPTER's business (src/server/course-adapters/):
 * the CS50 family has its own, every other course has the generic one, and
 * this module never asks which — it asks the registry.
 *
 * The pure half is core/courses.ts (the model), core/course-parse.ts (the
 * parsers) and core/course-adapters.ts (the seam); the persistence is
 * store/courses.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	htmlToMarkdown,
	parseSrtTimeline,
	parseUnitPage,
	type TimelineEntry,
} from "../core/course-parse.ts";
import {
	defaultCourseSettings,
	type ChatBinding,
	type Course,
	type CourseGrade,
	type CourseProblem,
	type CourseRequest,
	type CourseService,
	type CourseUnit,
	type ResolvedCourse,
} from "../core/courses.ts";
import { graderOf, parseCheckOutput, type CheckVerdict } from "../core/course-adapters.ts";
import { effectiveSettings } from "./stores.ts";
import { adapterFor, resolveCourseRef, requestFor, CS50_CATALOG } from "./course-adapters/index.ts";
import { cs50Adapter, cs50CourseFor } from "./course-adapters/cs50.ts";
import { genericAdapter } from "./course-adapters/generic.ts";
import { fetchPage, cachedPage } from "./course-pages.ts";
import { runCourseTool, runCs50Tool } from "./course-tool.ts";
import { readProblemFiles, languageOf, safeProblemPath, saveProblemFile } from "./problem-files.ts";
import { runSandboxed, toolchainEnv, workspaceRoot, type RunResult } from "./toolchain.ts";
import {
	bindChat,
	cachedPageIndex,
	chatBinding,
	courseDir,
	deleteCourse,
	listCourses,
	listCourseIds,
	readCourse,
	readCourseRequest,
	readProgress,
	updateProgress,
	writeCachedPage,
	writeCourse,
	writeCourseRequest,
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
 *  is a new entry in the CS50 catalogue, not a new module. */
export const COURSE_CATALOG: CourseDefinition[] = CS50_CATALOG;

/** One catalogue entry (null when the id is unknown). */
export function courseDefinition(id: string): CourseDefinition | null {
	return COURSE_CATALOG.find((c) => c.id === id) ?? null;
}

// ─── resolving what the learner asked for ───────────────────────────────────

/**
 * Resolve a reference — a catalogue id, a course URL or a course name —
 * into the course it names. The order: the catalogue, then a URL, then a
 * name (the catalogue's loose match, then the web).
 */
export async function resolveCourse(ref: string): Promise<ResolvedCourse> {
	return resolveCourseRef(ref);
}

/** The request an adapter needs (from a resolved course). */
function requestOf(resolved: ResolvedCourse): CourseRequest {
	return requestFor(resolved);
}

/** The request for a course already on disk (its own record remembers it). */
function storedRequest(courseId: string): CourseRequest | null {
	const stored = readCourseRequest(courseId);
	if (stored) return stored;
	const definition = courseDefinition(courseId);
	if (!definition) return null;
	return {
		courseId,
		ref: definition.id,
		source: definition.source,
		indexUrl: definition.indexUrl,
		title: definition.title,
		...(definition.edition ? { edition: definition.edition } : {}),
	};
}

/** Fill in what the catalogue knows and the caller did not (the CS50
 *  family's index page, its edition). */
function withCatalogueBits(request: CourseRequest): CourseRequest {
	const definition = courseDefinition(request.courseId);
	if (!definition) return request;
	return {
		...request,
		...(request.indexUrl ? {} : { indexUrl: definition.indexUrl }),
		...(request.edition ? {} : definition.edition ? { edition: definition.edition } : {}),
	};
}

// ─── fetching (cached) ──────────────────────────────────────────────────────

export { fetchPage, cachedPage };

/** How many pages are cached for a course (diagnostics). */
export function cachedPageCount(courseId: string): number {
	return Object.keys(cachedPageIndex(courseId)).length;
}

// ─── building the course ────────────────────────────────────────────────────

/**
 * Build (or rebuild) a course's plan from its source pages.
 *
 * The adapter does the reading: the CS50 one parses the site's own
 * structure, the generic one crawls the course's pages and lets the model
 * extract the outline. The result is the SKELETON: the units, their notes
 * links, their problems and their graders. The tutor then rewrites the
 * lessons and picks the problems — the tool never invents a timestamp.
 */
export async function buildCourse(courseId: string, request?: CourseRequest): Promise<Course> {
	const courseRequest = request ? withCatalogueBits(request) : requestOf(await resolveCourseFor(courseId));
	const adapter = adapterFor(courseRequest.ref);
	const outline = await adapter.outline(courseRequest);
	const now = new Date().toISOString();
	const existing = readCourse(courseId);
	const course = writeCourse({
		id: courseId,
		title: outline.title || courseRequest.title,
		source: outline.source || courseRequest.source,
		...(outline.edition ?? courseRequest.edition ? { edition: outline.edition ?? courseRequest.edition } : {}),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		settings: existing?.settings ?? defaultCourseSettings(),
		units: outline.units,
	});
	// The course remembers where it came from, so it can be rebuilt (and
	// so a generic course keeps its URL after a restart).
	writeCourseRequest(courseId, {
		courseId,
		ref: courseRequest.ref,
		title: course.title,
		source: course.source,
		...(course.edition ? { edition: course.edition } : {}),
		adapter: adapter.id,
	});
	writeCatalogue(course);
	return course;
}

/** The course a course id names (the catalogue, then the stored record). */
async function resolveCourseFor(courseId: string): Promise<ResolvedCourse> {
	const definition = courseDefinition(courseId);
	if (definition) {
		return {
			courseId,
			ref: definition.id,
			title: definition.title,
			source: definition.source,
			...(definition.edition ? { edition: definition.edition } : {}),
			adapter: "cs50",
		};
	}
	const stored = readCourseRequest(courseId);
	if (stored) {
		return {
			courseId,
			ref: stored.ref,
			title: stored.title,
			source: stored.source,
			...(stored.edition ? { edition: stored.edition } : {}),
			adapter: stored.adapter,
		};
	}
	throw new Error(`Unknown course: ${courseId}`);
}

/** Resolve a reference (a catalogue id, a course URL, a course name) and
 *  build the course it names — the one-prompt flow's server half. */
export async function buildCourseFromRef(ref: string): Promise<Course> {
	const resolved = await resolveCourse(ref);
	return buildCourse(resolved.courseId, requestFor(resolved));
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

/** One problem's folder inside the workspace (the spec's default layout:
 *  the workspace root is ~/cs50, so a problem lives in ~/cs50/<problem>). */
export function problemFolder(courseId: string, problemId: string): string {
	return path.join(workspaceRoot(), problemId);
}

/** One catalogue entry: the problem as the learner tool needs it. */
function catalogueProblem(problem: CourseProblem) {
	return {
		id: problem.id,
		title: problem.title,
		slug: problem.slug,
		specUrl: problem.specUrl,
		language: problem.language,
		file: problem.files.find((f) => f.name !== "README.md" && f.name !== "Makefile")?.name ?? "",
		folder: problem.id,
		readme: problem.files.find((f) => f.name === "README.md")?.content ?? "",
		files: Object.fromEntries(problem.files.map((f) => [f.name, f.content])),
		grader: graderOf(problem),
		graderCommand: problem.graderCommand ?? "",
		graderWorkDir: problem.graderWorkDir ?? "",
	};
}

/**
 * Write the workspace catalogue the learner tool reads (the tool is
 * deliberately dumb: it reads this, creates folders and shells out to the
 * grader).
 *
 * The catalogue holds EVERY course on disk — a learner can take two
 * courses at once — while the flat "problems" list stays the current
 * course's, which is what the tool read before.
 */
export function writeCatalogue(course: Course): string {
	const root = workspaceRoot();
	fs.mkdirSync(root, { recursive: true });
	const courses = listCourses();
	const entries = courses.map((entry) => ({
		courseId: entry.id,
		courseTitle: entry.title,
		problems: entry.units.flatMap((unit) => unit.problems.map(catalogueProblem)),
	}));
	const file = path.join(root, "catalogue.json");
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				courseId: course.id,
				courseTitle: course.title,
				workspaceRoot: root,
				problems: course.units.flatMap((unit) => unit.problems.map(catalogueProblem)),
				courses: entries,
			},
			null,
			"\t",
		),
		"utf-8",
	);
	return file;
}

/**
 * Prepare a problem's folder: the starter files (never overwriting the
 * learner's work), the starter archive or repository, and the workspace
 * catalogue.
 *
 * The adapter does the preparing — the CS50 one writes the spec's starter
 * code, the generic one also unpacks the course's archive or clones its
 * repository. When the course's own files give away a grader (the `ok`
 * client, a test suite), that grader is recorded on the problem, so the
 * label the course page shows and the check that runs agree.
 */
export async function prepareProblem(course: Course, problem: CourseProblem): Promise<{ folder: string; created: string[] }> {
	const folder = problemFolder(course.id, problem.id);
	fs.mkdirSync(folder, { recursive: true });
	const request = requestForCourse(course);
	const adapter = adapterFor(request.ref);
	const prepared = await adapter.prepare(request, problem, folder);
	// The grader the course's own files gave away is recorded on the
	// problem: the label the course page shows and the check that runs
	// must never disagree. Only the fields the adapter actually REPORTED
	// are compared — an adapter that reports no grader says nothing, and
	// says nothing is not a change.
	const graderChanged =
		(prepared.grader !== undefined && prepared.grader !== problem.grader) ||
		(prepared.graderCommand !== undefined && prepared.graderCommand !== (problem.graderCommand ?? "")) ||
		(prepared.graderWorkDir !== undefined && prepared.graderWorkDir !== (problem.graderWorkDir ?? ""));
	let updated = course;
	if (graderChanged) {
		const units = course.units.map((unit) => ({
			...unit,
			problems: unit.problems.map((entry) =>
				entry.id === problem.id
					? {
							...entry,
							...(prepared.grader ? { grader: prepared.grader } : {}),
							...(prepared.graderCommand ? { graderCommand: prepared.graderCommand } : {}),
							...(prepared.graderWorkDir ? { graderWorkDir: prepared.graderWorkDir } : {}),
						}
					: entry,
			),
		}));
		updated = saveCourse({ ...course, units, updatedAt: new Date().toISOString() });
	}
	// The catalogue is written AFTER the grader is recorded: the learner
	// tool reads it, and it must see the command the check really runs.
	writeCatalogue(updated);
	return { folder, created: prepared.created };
}

/** The request for a course on disk (its stored record, else the catalogue). */
function requestForCourse(course: Course): CourseRequest {
	const stored = readCourseRequest(course.id);
	if (stored) {
		return {
			courseId: course.id,
			ref: stored.ref,
			source: stored.source,
			title: stored.title,
			...(stored.edition ? { edition: stored.edition } : {}),
		};
	}
	const definition = courseDefinition(course.id);
	return {
		courseId: course.id,
		ref: definition?.id ?? course.source,
		source: course.source,
		...(definition?.indexUrl ? { indexUrl: definition.indexUrl } : {}),
		title: course.title,
		...(course.edition ? { edition: course.edition } : {}),
	};
}

export { readProblemFiles, languageOf, saveProblemFile };
export { toolchainEnv, workspaceRoot, runSandboxed, type RunResult };

// ─── grading ────────────────────────────────────────────────────────────────

/**
 * Grade the learner's work in a problem's folder.
 *
 * The adapter decides HOW (check50 for the CS50 family, the course's own
 * test runner or its `ok` client for everything else, the rubric when the
 * course ships no grader at all); this function is the one place that
 * decides WHICH, so the course page's label and the check that runs can
 * never disagree.
 */
export async function gradeProblem(course: Course, problem: CourseProblem): Promise<CourseGrade> {
	const folder = problemFolder(course.id, problem.id);
	const request = requestForCourse(course);
	const adapter = adapterFor(request.ref);
	return adapter.grade(request, problem, folder);
}

// ─── running ────────────────────────────────────────────────────────────────

/** The sample input the Run pane feeds a program that asks for something
 *  (a height, a name). The grader — not this — decides whether the
 *  program is right; the Run pane only shows that it builds and starts. */
const SAMPLE_INPUT = "8\n";

/** The toolchain's message when a program cannot be run (honest, never faked). */
function missingTool(tool: string, hint: string): RunResult {
	return {
		ok: false,
		output: `${tool} is not installed on this machine — install it, or work on the problem in VS Code.${hint ? ` ${hint}` : ""}`,
		command: tool,
	};
}

/**
 * The source file the Run pane runs: the one the problem's spec / starter
 * names, else the first source file of the problem's folder — or of one of
 * its subfolders, because a course that hands its lab out in "lab01/"
 * keeps the code there.
 *
 * A course's own test suite is never the learner's program: nothing under
 * a tests/ folder (or the hidden .grader/) is picked, and a file whose
 * name says it is a test ("test_lab01.py", "lab01_test.go") comes after
 * every other one.
 *
 * The file's own folder comes with it: the program runs WHERE it lives (a
 * lab's own imports and its data files are beside it).
 */
export function fileWith(folder: string, extensions: string[], fallback: string, preferred: string[] = []): { file: string; dir: string } {
	for (const name of preferred) {
		if (!extensions.some((extension) => name.endsWith(extension))) continue;
		if (inTestFolder(name)) continue;
		let full: string;
		try {
			full = safeProblemPath(folder, name);
		} catch {
			continue;
		}
		try {
			if (!fs.lstatSync(full).isFile()) continue;
		} catch {
			continue;
		}
		return { file: path.basename(full), dir: path.dirname(full) };
	}
	const found = findWithExtension(folder, extensions, 0, false) ?? findWithExtension(folder, extensions, 0, true);
	if (!found) return { file: fallback, dir: folder };
	return { file: path.basename(found), dir: path.dirname(found) };
}

/** The folders a course keeps its own tests (and grader) in. */
const TEST_FOLDERS = new Set(["tests", "test", "__tests__", "spec", "specs", ".grader"]);

/** Does this relative name live in a test folder? */
function inTestFolder(name: string): boolean {
	return name
		.replace(/\\/g, "/")
		.split("/")
		.slice(0, -1)
		.some((segment) => TEST_FOLDERS.has(segment));
}

/** Does this file's name say it is a test? */
function isTestFile(name: string): boolean {
	return /^test_|^test\.|[._-]test\.|[._-]spec\.|^conftest\.py$/i.test(name);
}

/** The first file with one of these extensions, in the folder or a
 *  subfolder (test-named files only when `tests` is set). */
function findWithExtension(folder: string, extensions: string[], depth: number, tests: boolean): string | null {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const extension of extensions) {
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
			if (isTestFile(entry.name) !== tests) continue;
			return path.join(folder, entry.name);
		}
	}
	if (depth >= 3) return null;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
		if (TEST_FOLDERS.has(entry.name)) continue;
		const found = findWithExtension(path.join(folder, entry.name), extensions, depth + 1, tests);
		if (found) return found;
	}
	return null;
}

/** Run the Run pane's step of a problem: build it, then run it.
 *
 *  C → `make` then the binary; C++ → `g++` then the binary; Python →
 *  `python3 <file>`; JavaScript → `node <file>`; TypeScript → `node` (type
 *  stripping) or `tsx`; SQL → `sqlite3 :memory:` with the file on stdin;
 *  Go → `go run`; Rust → `rustc` then the binary. A missing toolchain is
 *  reported honestly, never faked. */
export async function runProblem(course: Course, problem: CourseProblem): Promise<RunResult> {
	const folder = problemFolder(course.id, problem.id);
	if (!fs.existsSync(folder)) {
		return { ok: false, output: "The problem's files are not set up yet — open the problem first.", command: "" };
	}
	const language = problem.language;
	// The files the spec / starter names are the learner's program.
	const starterNames = problem.files.map((file) => file.name);

	if (language === "c" || language === "cpp") {
		const { file: source, dir } = fileWith(folder, language === "c" ? [".c"] : [".cpp", ".cc", ".cxx"], language === "c" ? "main.c" : "main.cpp", starterNames);
		const target = source.replace(/\.(c|cpp|cc|cxx)$/, "");
		const hasMakefile = fs.existsSync(path.join(dir, "Makefile"));
		const build = hasMakefile
			? await runSandboxed("make", [], { cwd: dir, writable: [folder] })
			: await runSandboxed(language === "c" ? "gcc" : "g++", [language === "c" ? "-std=c11" : "-std=c++17", "-O2", "-o", target, source], {
					cwd: dir,
					writable: [folder],
				});
		if (!build.ok) {
			if (/failed to start|ENOENT/i.test(build.output)) {
				return missingTool(
					language === "c" ? "gcc" : "g++",
					"A C/C++ compiler builds the program (Debian/Ubuntu: `sudo apt install build-essential`; macOS: the Xcode command line tools).",
				);
			}
			return { ...build, command: hasMakefile ? `make (${target})` : `${language === "c" ? "gcc" : "g++"} ${source}` };
		}
		const run = await runSandboxed(`./${target}`, [], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
		return { ...run, output: `${build.output}\n${run.output}`, command: `${hasMakefile ? "make" : language === "c" ? "gcc" : "g++"} && ./${target}` };
	}
	if (language === "python") {
		const { file, dir } = fileWith(folder, [".py"], "main.py", starterNames);
		return runSandboxed("python3", [file], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
	}
	if (language === "javascript") {
		const { file, dir } = fileWith(folder, [".js", ".mjs", ".cjs"], "main.js", starterNames);
		return runSandboxed("node", [file], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
	}
	if (language === "typescript") {
		const { file, dir } = fileWith(folder, [".ts", ".tsx"], "main.ts", starterNames);
		// Node strips the types itself (22.6+); tsx is the fallback for the
		// boxes whose node is older.
		const result = await runSandboxed("node", [file], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
		if (!result.ok && /unknown file extension|Cannot strip|ERR_UNKNOWN_FILE_EXTENSION/i.test(result.output)) {
			return runSandboxed("npx", ["--yes", "tsx", file], {
				cwd: dir,
				writable: [folder],
				timeoutMs: 60_000,
				keepStdinOpen: true,
				input: SAMPLE_INPUT,
			});
		}
		return result;
	}
	if (language === "sql") {
		const { file, dir } = fileWith(folder, [".sql"], "main.sql", starterNames);
		const sql = fs.readFileSync(path.join(dir, file), "utf-8");
		const result = await runSandboxed("sqlite3", [":memory:"], { cwd: dir, writable: [folder], timeoutMs: 20_000, input: sql });
		if (!result.ok && /failed to start|ENOENT/i.test(result.output)) {
			return {
				ok: false,
				output: "sqlite3 is not installed on this machine — install it, or work on the problem in VS Code.",
				command: "sqlite3 :memory:",
			};
		}
		return result;
	}
	if (language === "go") {
		const { file, dir } = fileWith(folder, [".go"], "main.go", starterNames);
		return runSandboxed("go", ["run", file], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 60_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
	}
	if (language === "rust") {
		const { file, dir } = fileWith(folder, [".rs"], "main.rs", starterNames);
		const target = "main-rust";
		const build = await runSandboxed("rustc", ["-O", "-o", target, file], { cwd: dir, writable: [folder] });
		if (!build.ok) {
			if (/failed to start|ENOENT/i.test(build.output)) return missingTool("rustc", "Rust's compiler builds the program (install it from https://rustup.rs).");
			return { ...build, command: `rustc ${file}` };
		}
		const run = await runSandboxed(`./${target}`, [], {
			cwd: dir,
			writable: [folder],
			timeoutMs: 20_000,
			keepStdinOpen: true,
			input: SAMPLE_INPUT,
		});
		return { ...run, output: `${build.output}\n${run.output}`, command: `rustc ${file} && ./${target}` };
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

// ─── the grader (the learner tool) ──────────────────────────────────────────

export { runCourseTool, runCs50Tool };
export { parseCheckOutput, type CheckVerdict };

export { readProgress, writeProgress, updateProgress, courseDir };
// The chat bindings (which course each session is about) — the routes
// bind a session to its course at creation.
export { bindChat, chatBinding };

export { cs50Adapter, genericAdapter, cs50CourseFor };
export { courseIdFor } from "../core/courses.ts";

// ─── the service (the agent tool's seam) ────────────────────────────────────

/**
 * THE COURSE SERVICE — the one object the agent layer is allowed to talk to.
 *
 * The agent may not import the server (the architecture law), so the
 * course tool receives this interface instead. Everything the tool needs —
 * the reference resolution, the syllabus fetch, the notes, the timeline,
 * the workspace, the progress and the chat bindings — hangs off it.
 */
export const courseService: CourseService = {
	listCourses: allCourses,
	getCourse,
	resolveCourse,
	buildCourse,
	unitNotes,
	unitTimeline,
	prepareProblem,
	gradeProblem,
	problemFolder,
	readProgress,
	updateProgress,
	saveCourse,
	chatBinding,
	bindChat,
};
