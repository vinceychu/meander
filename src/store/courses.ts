/**
 * COURSES STORE (2026-11-09): one folder per course under the data dir
 * (config.PATHS.courses):
 *
 *   <courses>/<courseId>/course.json      the plan (core/courses.ts Course)
 *   <courses>/<courseId>/progress.json    the learner's per-problem progress
 *   <courses>/<courseId>/pages/<hash>.html the fetched syllabus pages
 *   <courses>/<courseId>/pages.json        url → cached page index
 *
 * The page cache is what makes a course work OFFLINE after the first fetch:
 * the syllabus, the notes and the problem specs are all re-readable from
 * disk with no network. Reads are fresh (no in-memory cache): a course
 * folder is small, and a stale read would show the learner the wrong
 * progress.
 *
 * Writes go through writeFileAtomicSync (the store discipline: a reader
 * sees the old bytes or the complete new bytes, never a half-written file).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { applyProgress, type ChatBinding, type Course, type CourseProgress, type CourseProgressEntry, type ProblemStatus } from "../core/courses.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** One course's folder. */
export function courseDir(courseId: string): string {
	return path.join(PATHS.courses, courseId);
}

function courseFile(courseId: string): string {
	return path.join(courseDir(courseId), "course.json");
}

function progressFile(courseId: string): string {
	return path.join(courseDir(courseId), "progress.json");
}

function pagesIndexFile(courseId: string): string {
	return path.join(courseDir(courseId), "pages.json");
}

function pagesDir(courseId: string): string {
	return path.join(courseDir(courseId), "pages");
}

/** The course ids on disk (the folder names). */
export function listCourseIds(): string[] {
	try {
		return fs
			.readdirSync(PATHS.courses, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Read one course record (null when it does not exist or is unreadable). */
export function readCourse(courseId: string): Course | null {
	try {
		const raw = JSON.parse(fs.readFileSync(courseFile(courseId), "utf-8")) as Course;
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.units)) return null;
		return raw;
	} catch {
		return null;
	}
}

/** Every course on disk, newest first. */
export function listCourses(): Course[] {
	const out: Course[] = [];
	for (const id of listCourseIds()) {
		const course = readCourse(id);
		if (course) out.push(course);
	}
	return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Write the course record (the whole plan). */
export function writeCourse(course: Course): Course {
	fs.mkdirSync(courseDir(course.id), { recursive: true });
	writeFileAtomicSync(courseFile(course.id), JSON.stringify(course, null, "\t"), { allowInPlaceFallback: true });
	return course;
}

/** Delete a course folder (the plan, the progress and the cached pages). */
export function deleteCourse(courseId: string): void {
	fs.rmSync(courseDir(courseId), { recursive: true, force: true });
}

/** The course's progress map (empty when there is none). */
export function readProgress(courseId: string): CourseProgress {
	try {
		const raw = JSON.parse(fs.readFileSync(progressFile(courseId), "utf-8")) as CourseProgress;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

/** Write the progress map. */
export function writeProgress(courseId: string, progress: CourseProgress): CourseProgress {
	fs.mkdirSync(courseDir(courseId), { recursive: true });
	writeFileAtomicSync(progressFile(courseId), JSON.stringify(progress, null, "\t"), { allowInPlaceFallback: true });
	return progress;
}

/** Merge one progress update and persist it (absolute attempt counts). */
export function updateProgress(
	courseId: string,
	update: {
		unitId: string;
		problemId: string;
		status?: ProblemStatus;
		attempts?: number;
		hintsUsed?: number;
		solutionShown?: boolean;
		lastCheck?: string;
	},
	now = new Date().toISOString(),
): CourseProgressEntry {
	const progress = applyProgress(readProgress(courseId), courseId, update, now);
	writeProgress(courseId, progress);
	const key = `${update.unitId}/${update.problemId}`;
	return progress[key]!;
}

// ─── the page cache ──────────────────────────────────────────────────────────

interface PageIndex {
	[url: string]: { file: string; at: string };
}

function readPageIndex(courseId: string): PageIndex {
	try {
		const raw = JSON.parse(fs.readFileSync(pagesIndexFile(courseId), "utf-8")) as PageIndex;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

function pageFileName(url: string): string {
	return `${crypto.createHash("sha256").update(url).digest("hex").slice(0, 24)}.html`;
}

/** The cached page for a URL (null when it was never fetched). */
export function readCachedPage(courseId: string, url: string): string | null {
	const index = readPageIndex(courseId);
	const entry = index[url];
	if (!entry) return null;
	try {
		return fs.readFileSync(path.join(pagesDir(courseId), entry.file), "utf-8");
	} catch {
		return null;
	}
}

/** Cache a fetched page (the fetch layer calls this on every hit). */
export function writeCachedPage(courseId: string, url: string, html: string): void {
	const dir = pagesDir(courseId);
	fs.mkdirSync(dir, { recursive: true });
	const file = pageFileName(url);
	fs.writeFileSync(path.join(dir, file), html, "utf-8");
	const index = readPageIndex(courseId);
	index[url] = { file, at: new Date().toISOString() };
	writeFileAtomicSync(pagesIndexFile(courseId), JSON.stringify(index, null, "\t"), { allowInPlaceFallback: true });
}

/** The cached page index (url → file + timestamp) — for diagnostics. */
export function cachedPageIndex(courseId: string): PageIndex {
	return readPageIndex(courseId);
}

// ─── the course requests ─────────────────────────────────────────────────────

const REQUESTS_FILE = path.join(PATHS.courses, "requests.json");

/** One course's request: where it came from, so it can be rebuilt. */
export interface CourseRequestRecord {
	courseId: string;
	/** What the learner gave (a catalogue id, a URL, a name). */
	ref: string;
	title: string;
	source: string;
	edition?: string;
	/** Which adapter read it ("cs50", "generic"). */
	adapter: string;
}

function readRequests(): Record<string, CourseRequestRecord> {
	try {
		const raw = JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf-8")) as Record<string, CourseRequestRecord>;
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

/** One course's request (null when it was never recorded). */
export function readCourseRequest(courseId: string): CourseRequestRecord | null {
	return readRequests()[courseId] ?? null;
}

/** Record a course's request (the course remembers where it came from). */
export function writeCourseRequest(courseId: string, record: CourseRequestRecord): CourseRequestRecord {
	const requests = readRequests();
	requests[courseId] = record;
	fs.mkdirSync(PATHS.courses, { recursive: true });
	writeFileAtomicSync(REQUESTS_FILE, JSON.stringify(requests, null, "\t"), { allowInPlaceFallback: true });
	return record;
}

// ─── the chat bindings ──────────────────────────────────────────────────────

const BINDINGS_FILE = path.join(PATHS.courses, "bindings.json");

/** Which course each chat is working on (chatId → binding). */
export function readChatBindings(): Record<string, ChatBinding> {
	try {
		const raw = JSON.parse(fs.readFileSync(BINDINGS_FILE, "utf-8")) as Record<string, ChatBinding>;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return raw;
	} catch {
		return {};
	}
}

/** One chat's binding (null when it has none). */
export function chatBinding(chatId: string): ChatBinding | null {
	return readChatBindings()[chatId] ?? null;
}

/** Bind a chat to a course (and optionally a problem). */
export function bindChat(chatId: string, binding: ChatBinding): void {
	const bindings = readChatBindings();
	bindings[chatId] = binding;
	fs.mkdirSync(PATHS.courses, { recursive: true });
	writeFileAtomicSync(BINDINGS_FILE, JSON.stringify(bindings, null, "\t"), { allowInPlaceFallback: true });
}
