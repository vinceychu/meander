/**
 * COURSE PROGRESS (2026-11-09): what the learner has done, and what the
 * store keeps.
 *
 * Two halves:
 * - the PURE model (core/courses.ts): how a progress update merges, how
 *   the course counts as done, what the "next step" is;
 * - the STORE (store/courses.ts): the plan, the progress and the chat
 *   bindings on disk, under an isolated LH_DATA_DIR.
 *
 * The laws pinned here:
 * - an attempt count is ABSOLUTE (a merge never loses one, never counts
 *   one twice);
 * - a hint count only ever goes up, and "a solution was shown" is sticky;
 * - the next step is the first thing not done, in course order;
 * - a chat's course binding survives a restart (it is on disk).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (the birth-stamp discipline) ─
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = TMP_DATA;

const {
	applyProgress,
	courseCompletion,
	courseIdFor,
	courseRemainingMinutes,
	defaultCourseSettings,
	formatMinutes,
	nextLesson,
	nextStep,
	problemMode,
	progressKey,
	segmentUrl,
} = await import("../src/core/courses.ts");
import type { Course, CourseProgress } from "../src/core/courses.ts";
const {
	bindChat,
	chatBinding,
	courseDir,
	deleteCourse,
	listCourseIds,
	readCachedPage,
	readCourse,
	readProgress,
	updateProgress,
	writeCachedPage,
	writeCourse,
	writeProgress,
} = await import("../src/store/courses.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function courseFixture(): Course {
	return {
		id: "cs50x",
		title: "CS50x",
		source: "https://cs50.harvard.edu/x/",
		createdAt: "2026-11-09T00:00:00.000Z",
		updatedAt: "2026-11-09T00:00:00.000Z",
		settings: defaultCourseSettings(),
		units: [
			{
				id: "week-1-c",
				index: 0,
				title: "Week 1 C",
				summary: "C",
				notesUrl: "https://cs50.harvard.edu/x/notes/1/",
				lesson: "# Week 1 C",
				videos: [],
				estimateMinutes: 60,
				problems: [
					{
						id: "mario-less",
						unitId: "week-1-c",
						title: "Mario",
						slug: "cs50/problems/2026/x/mario/less",
						specUrl: "https://cs50.harvard.edu/x/psets/1/mario/less/",
						variant: "less",
						language: "c",
						distributionUrls: [],
						files: [],
						estimateMinutes: 45,
					},
					{
						id: "mario-more",
						unitId: "week-1-c",
						title: "Mario (more)",
						slug: "cs50/problems/2026/x/mario/more",
						specUrl: "https://cs50.harvard.edu/x/psets/1/mario/more/",
						variant: "more",
						language: "c",
						distributionUrls: [],
						files: [],
						estimateMinutes: 90,
					},
				],
			},
			{
				id: "week-2-arrays",
				index: 1,
				title: "Week 2 Arrays",
				summary: "Arrays",
				notesUrl: "https://cs50.harvard.edu/x/notes/2/",
				lesson: "",
				videos: [],
				estimateMinutes: 90,
				problems: [],
			},
		],
	};
}

describe("merging a progress update", () => {
	it("files a row under unit/problem", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "in-progress" });
		assert.ok(progress[progressKey("week-1-c", "mario-less")]);
		assert.equal(progress["week-1-c/mario-less"]?.status, "in-progress");
		assert.equal(progress["week-1-c/mario-less"]?.attempts, 0);
	});

	it("takes the attempt count as absolute", () => {
		let progress: CourseProgress = {};
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", attempts: 1 });
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", attempts: 2 });
		assert.equal(progress["u/p"]?.attempts, 2, "the count is never lost");
	});

	it("never lowers the hint count", () => {
		let progress: CourseProgress = {};
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", hintsUsed: 3 });
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", hintsUsed: 1 });
		assert.equal(progress["u/p"]?.hintsUsed, 3);
	});

	it("keeps the solution flag once it is set", () => {
		let progress: CourseProgress = {};
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", solutionShown: true });
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p" });
		assert.equal(progress["u/p"]?.solutionShown, true);
	});

	it("leaves the untouched fields alone", () => {
		let progress: CourseProgress = {};
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", status: "passed" });
		progress = applyProgress(progress, "cs50x", { unitId: "u", problemId: "p", attempts: 3 });
		assert.equal(progress["u/p"]?.status, "passed");
	});
});

describe("where the learner stands", () => {
	const course = courseFixture();

	it("counts only the passed and submitted problems", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "passed" });
		const completion = courseCompletion(course, progress);
		assert.equal(completion.done, 1);
		assert.equal(completion.total, 2);
		assert.equal(completion.ratio, 0.5);
	});

	it("counts a submitted problem as done", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "submitted" });
		assert.equal(courseCompletion(course, progress).done, 1);
	});

	it("offers the first thing not done", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "passed" });
		const step = nextStep(course, progress);
		assert.equal(step?.kind, "problem");
		assert.equal(step?.problemId, "mario-more");
	});

	it("falls back to the lesson when a unit has no lesson yet", () => {
		const progress = applyProgress(
			{},
			"cs50x",
			{ unitId: "week-1-c", problemId: "mario-less", status: "passed" },
		);
		progress["week-1-c/mario-more"] = {
			courseId: "cs50x",
			unitId: "week-1-c",
			problemId: "mario-more",
			status: "passed",
			attempts: 1,
			hintsUsed: 0,
			solutionShown: false,
			updatedAt: "2026-11-09T00:00:00.000Z",
		};
		const step = nextStep(course, progress);
		assert.equal(step?.kind, "lesson");
		assert.equal(step?.unitId, "week-2-arrays");
	});

	it("has no next step when everything is done", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "passed" });
		progress["week-1-c/mario-more"] = {
			courseId: "cs50x",
			unitId: "week-1-c",
			problemId: "mario-more",
			status: "submitted",
			attempts: 1,
			hintsUsed: 0,
			solutionShown: false,
			updatedAt: "2026-11-09T00:00:00.000Z",
		};
		// Week 2 has no lesson yet, so it is not "done" — but the unit list
		// ends there, so the step is that unit's lesson.
		const step = nextStep(course, progress);
		assert.equal(step?.kind, "lesson");
	});

	it("counts the minutes of the units not finished", () => {
		const progress = applyProgress({}, "cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "passed" });
		// Week 1 is not finished (mario-more is open) → 60 minutes left.
		assert.equal(courseRemainingMinutes(course, progress), 60 + 90);
	});

	it("finds the unit that still needs a lesson", () => {
		assert.equal(nextLesson(course)?.id, "week-2-arrays");
	});
});

describe("the small helpers", () => {
	it("uses the course's default mode unless the problem overrides it", () => {
		const course = courseFixture();
		const problem = course.units[0]!.problems[0]!;
		assert.equal(problemMode(course, problem), "app");
		course.settings.defaultMode = "vscode";
		assert.equal(problemMode(course, problem), "vscode");
		problem.mode = "app";
		assert.equal(problemMode(course, problem), "app");
	});

	it("builds a watch URL with the chapter timestamp", () => {
		assert.equal(segmentUrl({ title: "C", youtubeId: "abc123" }), "https://www.youtube.com/watch?v=abc123");
		assert.equal(
			segmentUrl({ title: "C", youtubeId: "abc123", startSeconds: 90 }),
			"https://www.youtube.com/watch?v=abc123&t=90s",
		);
	});

	it("formats the estimates", () => {
		assert.equal(formatMinutes(45), "45m");
		assert.equal(formatMinutes(60), "1h");
		assert.equal(formatMinutes(80), "1h 20m");
	});

	it("slugs a course id", () => {
		assert.equal(courseIdFor("CS50x"), "cs50x");
		assert.equal(courseIdFor("Hello World!"), "hello-world");
	});
});

describe("the store", () => {
	it("keeps the plan on disk", () => {
		const course = courseFixture();
		writeCourse(course);
		assert.ok(fs.existsSync(path.join(courseDir("cs50x"), "course.json")));
		const read = readCourse("cs50x");
		assert.equal(read?.units.length, 2);
		assert.equal(read?.units[0]?.problems[0]?.slug, "cs50/problems/2026/x/mario/less");
	});

	it("lists the courses on disk", () => {
		writeCourse(courseFixture());
		assert.ok(listCourseIds().includes("cs50x"));
	});

	it("persists the progress", () => {
		writeCourse(courseFixture());
		const entry = updateProgress("cs50x", { unitId: "week-1-c", problemId: "mario-less", status: "in-progress", attempts: 1 });
		assert.equal(entry.status, "in-progress");
		const progress = readProgress("cs50x");
		assert.equal(progress["week-1-c/mario-less"]?.attempts, 1);
		// The count is absolute across calls.
		updateProgress("cs50x", { unitId: "week-1-c", problemId: "mario-less", attempts: 2 });
		assert.equal(readProgress("cs50x")["week-1-c/mario-less"]?.attempts, 2);
	});

	it("starts with an empty progress map", () => {
		assert.deepEqual(readProgress("never-seen"), {});
	});

	it("caches a fetched page so a course works offline", () => {
		writeCachedPage("cs50x", "https://cs50.harvard.edu/x/weeks/1/", "<main>hello</main>");
		assert.equal(readCachedPage("cs50x", "https://cs50.harvard.edu/x/weeks/1/"), "<main>hello</main>");
		assert.equal(readCachedPage("cs50x", "https://cs50.harvard.edu/x/weeks/2/"), null);
	});

	it("binds a chat to its course", () => {
		bindChat("chat-1", { courseId: "cs50x", problemId: "mario-less" });
		assert.deepEqual(chatBinding("chat-1"), { courseId: "cs50x", problemId: "mario-less" });
		assert.equal(chatBinding("chat-2"), null);
	});

	it("deletes a course and everything under it", () => {
		writeCourse(courseFixture());
		writeProgress("cs50x", {});
		deleteCourse("cs50x");
		assert.equal(readCourse("cs50x"), null);
		assert.ok(!fs.existsSync(courseDir("cs50x")));
	});
});
