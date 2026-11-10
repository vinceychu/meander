/**
 * THE COURSE PLANNER TOOL (2026-11-09): the `course_plan` agent tool.
 *
 * The law that matters here is the TIMESTAMP one: a committed video slice
 * may only point at a moment the course actually knows about — the
 * lecture's own subtitle timeline, or a chapter mark on a problem's own
 * walkthrough. An invented timestamp is REJECTED, with the real ones
 * listed, and a rejected commit writes NOTHING.
 *
 * The tool talks to the server through the CourseService seam (the agent
 * may not import the server), so the test supplies its own.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courseTools } from "../src/agent/tools/course.ts";
import { applyProgress, progressKey } from "../src/core/courses.ts";
import type {
	ChatBinding,
	Course,
	CourseProgress,
	CourseProgressEntry,
	CourseService,
	CourseUnit,
} from "../src/core/courses.ts";

const LECTURE = "SlqjA04_dpk";
const WALKTHROUGH = "NAs4FIWkJ4s";
const TIMELINE = [
	{ seconds: 0, text: "Hello and welcome." },
	{ seconds: 60, text: "Compilers." },
	{ seconds: 120, text: "Types." },
];

function courseFixture(): Course {
	const unit: CourseUnit = {
		id: "week-1-c",
		index: 0,
		title: "Week 1 C",
		summary: "C",
		notesUrl: "https://cs50.harvard.edu/x/notes/1/",
		pageUrl: "https://cs50.harvard.edu/x/weeks/1/",
		videoId: LECTURE,
		lesson: "",
		videos: [],
		estimateMinutes: 60,
		problems: [
			{
				id: "mario-less",
				unitId: "week-1-c",
				title: "Mario",
				slug: "cs50/problems/2026/x/mario/less",
				specUrl: "https://cs50.harvard.edu/x/psets/1/mario/less/",
				videoEmbeds: [{ youtubeId: WALKTHROUGH, startSeconds: 11 }],
				variant: "less",
				language: "c",
				distributionUrls: [],
				files: [],
				estimateMinutes: 45,
			},
		],
	};
	return {
		id: "cs50x",
		title: "CS50x",
		source: "https://cs50.harvard.edu/x/",
		createdAt: "2026-11-09T00:00:00.000Z",
		updatedAt: "2026-11-09T00:00:00.000Z",
		settings: { defaultMode: "app", videos: false },
		units: [unit],
	};
}

/** A course service over an in-memory course. */
function serviceFixture() {
	let course = courseFixture();
	const bindings = new Map<string, ChatBinding>();
	const progress: CourseProgress = {};
	const service: CourseService = {
		listCourses: () => [course],
		getCourse: () => course,
		resolveCourse: async (ref: string) => ({
			courseId: "cs50x",
			ref,
			title: "CS50x",
			source: "https://cs50.harvard.edu/x/",
			edition: "2026",
			adapter: "cs50",
		}),
		buildCourse: async () => course,
		unitNotes: async () => "# Week 1 C\n\nThe notes.",
		unitTimeline: async (_courseId: string, unit: CourseUnit) =>
			unit.videoId === LECTURE ? TIMELINE : [],
		prepareProblem: async () => ({ folder: "/tmp/mario-less", created: [] }),
		gradeProblem: async () => ({
			ok: true,
			lines: ["[ok] compiles"],
			passed: 1,
			total: 1,
			causes: [],
			grader: "check50",
			output: "[ok] compiles\n1/1 checks passed",
		}),
		problemFolder: () => "/tmp/mario-less",
		readProgress: () => progress,
		updateProgress: (courseId, update) => {
			const merged = applyProgress(progress, courseId, update);
			for (const key of Object.keys(progress)) delete progress[key];
			Object.assign(progress, merged);
			return merged[progressKey(update.unitId, update.problemId)]!;
		},
		saveCourse: (next: Course) => {
			course = next;
			return next;
		},
		chatBinding: (chatId: string) => bindings.get(chatId) ?? null,
		bindChat: (chatId: string, binding: ChatBinding) => {
			bindings.set(chatId, binding);
		},
	};
	return { service, bindings, current: () => course };
}

/** Call the tool and return its raw result object. */
async function call(service: CourseService, chatId: string, input: Record<string, unknown>) {
	const tools = courseTools({ chatId, courses: service });
	const tool = tools.course_plan!;
	const result = await tool.execute!("call-1", input, undefined);
	return result.details as { ok: boolean; error?: string; [key: string]: unknown };
}

describe("the outline", () => {
	it("reads the course and binds the chat to it", async () => {
		const { service, bindings } = serviceFixture();
		const result = await call(service, "chat-1", { action: "outline" });
		assert.equal(result.ok, true);
		assert.equal(bindings.get("chat-1")?.courseId, "cs50x");
		const units = result.units as Array<{ id: string; problems: Array<{ id: string; slug: string }> }>;
		assert.equal(units[0]?.id, "week-1-c");
		assert.equal(units[0]?.problems[0]?.slug, "cs50/problems/2026/x/mario/less");
	});
});

describe("committing a plan", () => {
	it("writes the lesson, the problems and the estimate", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [
				{
					id: "week-1-c",
					lesson: "# Week 1 C\n\nC is a language.",
					estimateMinutes: 90,
					problems: [{ id: "mario-less", estimateMinutes: 60 }],
				},
			],
		});
		assert.equal(result.ok, true, result.error);
		const unit = current().units[0]!;
		assert.match(unit.lesson, /C is a language/);
		assert.equal(unit.estimateMinutes, 90);
		assert.equal(unit.problems.length, 1);
		assert.equal(unit.problems[0]?.estimateMinutes, 60);
	});

	it("accepts a timestamp that is on the lecture's timeline", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "Compilers", youtubeId: LECTURE, startSeconds: 60 }] }],
		});
		assert.equal(result.ok, true, result.error);
		assert.equal(current().units[0]?.videos[0]?.startSeconds, 60);
	});

	it("REJECTS an invented timestamp — and lists the real ones", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "Made up", youtubeId: LECTURE, startSeconds: 777 }] }],
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /is not a timestamp of the lecture/);
		assert.match(result.error ?? "", /0:00/);
		assert.match(result.error ?? "", /2:00/);
		// Nothing was written.
		assert.equal(current().units[0]?.videos.length, 0);
	});

	it("REJECTS a video id the course does not have", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "Somewhere else", youtubeId: "aaaaaaaaaaa" }] }],
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /is not one of this unit's videos/);
		assert.match(result.error ?? "", /outline/);
	});

	it("accepts a problem's own walkthrough mark", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "The demo", youtubeId: WALKTHROUGH, startSeconds: 11 }] }],
		});
		assert.equal(result.ok, true, result.error);
		assert.equal(current().units[0]?.videos[0]?.youtubeId, WALKTHROUGH);
	});

	it("rejects a timestamp on a walkthrough that has no mark", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "The demo", youtubeId: WALKTHROUGH, startSeconds: 30 }] }],
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /not a timestamp/);
	});

	it("accepts a plain link for a video with no verified track", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", videos: [{ title: "The demo", youtubeId: WALKTHROUGH }] }],
		});
		assert.equal(result.ok, true, result.error);
		assert.equal(current().units[0]?.videos[0]?.startSeconds, undefined);
	});

	it("writes nothing at all when one segment is bad", async () => {
		const { service, current } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [
				{
					id: "week-1-c",
					lesson: "# A good lesson",
					videos: [
						{ title: "Fine", youtubeId: LECTURE, startSeconds: 0 },
						{ title: "Made up", youtubeId: LECTURE, startSeconds: 777 },
					],
				},
			],
		});
		assert.equal(result.ok, false);
		assert.equal(current().units[0]?.lesson, "", "the whole commit was rejected");
		assert.equal(current().units[0]?.videos.length, 0);
	});

	it("refuses a problem the unit does not have", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "commit",
			units: [{ id: "week-1-c", problems: [{ id: "mario-more" }] }],
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /has no problem "mario-more"/);
	});
});

describe("the status", () => {
	it("reports where the learner stands", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", { action: "status" });
		assert.equal(result.ok, true);
		assert.equal(result.completion, "0/1 problems");
		assert.equal(result.remaining, "1h");
	});
});

describe("the progress", () => {
	it("counts an attempt and marks the problem passed", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", {
			action: "progress",
			problemId: "mario-less",
			attempt: true,
			status: "passed",
		});
		assert.equal(result.ok, true, result.error);
		const entry = result.progress as CourseProgressEntry;
		assert.equal(entry.attempts, 1);
		assert.equal(entry.status, "passed");
	});

	it("counts a hint and keeps the solution flag", async () => {
		const { service } = serviceFixture();
		await call(service, "chat-1", { action: "progress", problemId: "mario-less", hint: true });
		const result = await call(service, "chat-1", {
			action: "progress",
			problemId: "mario-less",
			hint: true,
			solutionShown: true,
		});
		const entry = result.progress as CourseProgressEntry;
		assert.equal(entry.hintsUsed, 2);
		assert.equal(entry.solutionShown, true);
	});

	it("never downgrades a passed problem", async () => {
		const { service } = serviceFixture();
		await call(service, "chat-1", { action: "progress", problemId: "mario-less", status: "passed" });
		const result = await call(service, "chat-1", {
			action: "progress",
			problemId: "mario-less",
			attempt: true,
			status: "in-progress",
		});
		const entry = result.progress as CourseProgressEntry;
		assert.equal(entry.status, "passed");
		assert.equal(entry.attempts, 1);
	});

	it("names the problem it cannot find", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", { action: "progress", problemId: "nope" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /No problem "nope"/);
	});
});

describe("the segments", () => {
	it("gives the real timestamps of a lecture", async () => {
		const { service } = serviceFixture();
		const result = await call(service, "chat-1", { action: "segments", unitId: "week-1-c" });
		assert.equal(result.ok, true);
		const timeline = result.timeline as Array<{ seconds: number; time: string }>;
		assert.deepEqual(timeline.map((entry) => entry.seconds), [0, 60, 120]);
		assert.equal(timeline[1]?.time, "1:00");
	});
});
