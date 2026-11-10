import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import {
	courseCompletion,
	courseRemainingMinutes,
	formatMinutes,
	nextStep,
	progressKey,
	type Course,
	type CourseProblem,
	type CourseRequest,
	type CourseService,
	type CourseUnit,
	type CourseVideoSegment,
} from "../../core/courses.ts";
import { graderLabel, graderOf } from "../../core/course-adapters.ts";
import { formatTimestamp } from "../../core/course-parse.ts";

/**
 * THE COURSE PLANNER (2026-11-09) — one tool, `course_plan`, that turns a
 * course into a plan the learner can follow.
 *
 * The tutor drives it in six moves:
 *
 *   outline    fetch the course's syllabus (cached on disk) and read the
 *              outline: the units, their notes, their problems and their
 *              check50 slugs. After this the tutor knows the course.
 *   notes      the unit's notes, condensed — the material the lesson is
 *              built from.
 *   segments   the lecture's sampled timeline: the REAL timestamps a video
 *              segment may point at.
 *   commit     write the plan: per unit a condensed lesson, 2–5 video
 *              segments, the problems to do and the time estimates.
 *   status     where the learner stands: the progress, the next step.
 *   progress   record what happened on a problem: an attempt (a check),
 *              a graded hint, a solution that was shown.
 *
 * The timestamps are the discipline: a committed video segment is checked
 * against the lecture's own subtitle timeline, and a segment whose
 * timestamp is not in that timeline is REJECTED — the tool never stores an
 * invented one. A segment on a video with no timeline (no subtitles) is
 * stored as a plain lecture link, without a timestamp.
 *
 * The tool is registered for BOTH agents: the prober owns the first turn
 * ("I want to learn CS50"), so the route into a course must exist before
 * the probe concludes.
 */

/** What the tool closes over. */
export interface CourseToolContext {
	/** The chat the tool belongs to (the binding lives per chat). */
	chatId: string;
	/** The course service (server-side: network + filesystem). */
	courses: CourseService;
}

const videoInput = Type.Object({
	title: Type.String({ minLength: 1, description: "What this slice teaches (the learner's words)." }),
	youtubeId: Type.String({ minLength: 1, description: "The lecture's YouTube id (from the outline / the segments call)." }),
	startSeconds: Type.Optional(
		Type.Number({ description: "Where the slice starts, in seconds — a timestamp from the segments call. Omit it when the video has no timeline." }),
	),
	note: Type.Optional(Type.String({ description: "Why this slice is worth the minutes." })),
});

const problemInput = Type.Object({
	id: Type.String({ minLength: 1, description: "The problem's id from the outline (e.g. 'mario-less')." }),
	estimateMinutes: Type.Optional(Type.Number({ description: "How long the problem should take." }),
	),
});

const unitInput = Type.Object({
	id: Type.Optional(Type.String({ description: "The unit's id from the outline. Omit it to go by position." })),
	lesson: Type.Optional(Type.String({ description: "The unit's condensed lesson (markdown) — built from the notes, in your own words." })),
	estimateMinutes: Type.Optional(Type.Number({ description: "How long the unit takes, lesson included." })),
	videos: Type.Optional(Type.Array(videoInput, { description: "2–5 slices worth watching (empty when the learner asked to skip videos)." })),
	problems: Type.Optional(
		Type.Array(problemInput, {
			description: "The problems of this unit to do, in order (the ids come from the outline; this REPLACES the unit's list).",
		}),
	),
});

const coursePlanInput = Type.Object({
	action: Type.Union(
		[
			Type.Literal("outline"),
			Type.Literal("notes"),
			Type.Literal("segments"),
			Type.Literal("commit"),
			Type.Literal("status"),
			Type.Literal("progress"),
			Type.Literal("workspace"),
		],
		{ description: "outline = fetch the syllabus and read it; notes = one unit's notes; segments = one lecture's timeline; commit = write the plan; status = the learner's progress; progress = record what happened on a problem (an attempt, a hint, a solution); workspace = set a problem's files up." },
	),
	course: Type.Optional(Type.String({ description: "The course: a catalogue id ('cs50x'), a course URL, or a course name (default: the course this session is already on, else 'cs50x')." })),
	unitId: Type.Optional(Type.String({ description: "The unit (notes / segments)." })),
	problemId: Type.Optional(Type.String({ description: "The problem (workspace / progress)." })),
	status: Type.Optional(
		Type.Union([Type.Literal("todo"), Type.Literal("in-progress"), Type.Literal("passed"), Type.Literal("submitted")], {
			description: "Where the problem stands now (progress). 'passed' means every check passed; 'submitted' means the learner submitted it to the course.",
		}),
	),
	attempt: Type.Optional(Type.Boolean({ description: "The learner just ran a check (progress): count one more attempt." })),
	attempts: Type.Optional(Type.Number({ description: "The absolute attempt count (progress) — use only when you know the exact number." })),
	hint: Type.Optional(Type.Boolean({ description: "You just gave a graded hint (progress): count one more hint." })),
	solutionShown: Type.Optional(Type.Boolean({ description: "You showed a full solution (progress) — the record keeps this forever." })),
	lastCheck: Type.Optional(Type.String({ description: "The grader's last verdict in one line (progress), e.g. '9/10 checks passed'." })),
	units: Type.Optional(Type.Array(unitInput, { description: "The plan to write (commit). Only the fields you set are changed." })),
});

/** The course id the tool falls back to. */
const DEFAULT_COURSE = "cs50x";

/** Resolve the course: the call's id, else the chat's binding, else the default. */
function resolveCourseId(ctx: CourseToolContext, requested: string | undefined): string {
	if (requested?.trim()) return requested.trim();
	const bound = ctx.courses.chatBinding(ctx.chatId);
	return bound?.courseId ?? DEFAULT_COURSE;
}

/** The unit by id (or by position when the id is unknown). */
function findUnit(course: Course, unitId: string | undefined, position: number): CourseUnit | undefined {
	if (unitId) {
		const byId = course.units.find((u) => u.id === unitId);
		if (byId) return byId;
	}
	return course.units[position];
}

/** The compact outline the tutor reads (the context diet: no lesson text). */
function outlineOf(course: Course) {
	return {
		courseId: course.id,
		title: course.title,
		edition: course.edition,
		source: course.source,
		units: course.units.map((unit) => ({
			id: unit.id,
			index: unit.index,
			title: unit.title,
			summary: unit.summary.slice(0, 400),
			notesUrl: unit.notesUrl,
			pageUrl: unit.pageUrl,
			videoId: unit.videoId,
			hasLesson: unit.lesson.trim().length > 0,
			estimateMinutes: unit.estimateMinutes,
			problems: unit.problems.map((problem) => ({
				id: problem.id,
				title: problem.title,
				variant: problem.variant,
				language: problem.language,
				slug: problem.slug,
				specUrl: problem.specUrl,
				videoEmbeds: problem.videoEmbeds ?? [],
				estimateMinutes: problem.estimateMinutes,
				grader: graderOf(problem),
				graderLabel: graderLabel(problem),
			})),
		})),
	};
}

/** The problem by id (inside the course). */
function findProblem(course: Course, problemId: string): { unit: CourseUnit; problem: CourseProblem } | undefined {
	for (const unit of course.units) {
		for (const problem of unit.problems) {
			if (problem.id === problemId) return { unit, problem };
		}
	}
	return undefined;
}

/**
 * Validate the committed video segments against what the course actually
 * knows about its videos.
 *
 * A segment may point at:
 *   - the unit's LECTURE — then its timestamp must be on the lecture's own
 *     subtitle timeline (read from the lecture's own .srt), or
 *   - one of the unit's PROBLEM walkthroughs — then its timestamp must be
 *     the chapter mark the problem's spec page gives.
 *
 * Anything else, or a timestamp that is not one of those, is an invention:
 * it is REJECTED, with the real timestamps the tutor may use. A video with
 * no verifiable timeline accepts a plain link (no timestamp).
 */
async function validateVideos(
	ctx: CourseToolContext,
	course: Course,
	unit: CourseUnit,
	videos: CourseVideoSegment[],
): Promise<string[]> {
	const problems: string[] = [];
	const timeline = await ctx.courses.unitTimeline(course.id, unit);
	const lectureSeconds = timeline.map((entry) => entry.seconds);
	// The videos a segment may point at, and where their timestamps come from.
	const allowed = new Map<string, { seconds: number[]; label: string }>();
	if (unit.videoId) {
		allowed.set(unit.videoId, { seconds: lectureSeconds, label: "the lecture" });
	}
	for (const problem of unit.problems) {
		for (const embed of problem.videoEmbeds ?? []) {
			if (allowed.has(embed.youtubeId)) continue;
			allowed.set(embed.youtubeId, {
				seconds: embed.startSeconds === undefined ? [] : [embed.startSeconds],
				label: `${problem.title}'s walkthrough`,
			});
		}
	}
	for (const video of videos) {
		const known = allowed.get(video.youtubeId);
		if (!known) {
			const ids = [...allowed.keys()];
			problems.push(
				`"${video.title}": the video id ${video.youtubeId} is not one of this unit's videos` +
					(ids.length > 0 ? ` (use ${ids.join(" or ")})` : " — this unit has no lecture video; link the notes instead") +
					". Take the id from the 'outline' call.",
			);
			continue;
		}
		if (video.startSeconds === undefined) continue;
		const seconds = Math.floor(video.startSeconds);
		if (known.seconds.length === 0) {
			problems.push(
				`"${video.title}": ${known.label} has no verified timestamp track, so ${formatTimestamp(seconds)} cannot be verified — drop startSeconds and link the video.`,
			);
			continue;
		}
		const hit = known.seconds.some((real) => Math.abs(real - seconds) <= 3);
		if (!hit) {
			const sample = [...known.seconds].sort((a, b) => a - b).slice(0, 12);
			problems.push(
				`"${video.title}": ${formatTimestamp(seconds)} is not a timestamp of ${known.label}. ` +
					`Real timestamps (call action "segments" for the full timeline): ${sample.map((s) => formatTimestamp(s)).join(", ")}.`,
			);
		}
	}
	return problems;
}

export function courseTools(ctx: CourseToolContext): Record<string, AgentTool<any>> {
	return {
		course_plan: {
			name: "course_plan",
			label: "course_plan",
			description:
				"Plan a whole course for the learner: fetch the syllabus, read the notes, pick the video segments, decide which problems to do, and write the plan. " +
				"Actions: 'outline' (fetch the course's units, notes links, problems and graders — cached on disk, so it works offline afterwards; the course may be a catalogue id, a course URL or a course name), " +
				"'notes' (one unit's notes, to build its lesson from), 'segments' (one lecture's timeline: the real timestamps a video slice may point at), " +
				"'commit' (write the plan: per unit a condensed lesson, 2-5 video slices, the problems to do, the time estimates), " +
				"'status' (the learner's progress and the next step), 'progress' (record an attempt, a hint or a solution shown), " +
				"'workspace' (set a problem's files up on disk). " +
				"NEVER invent a video timestamp: take it from the 'segments' call — a timestamp that is not in the lecture's timeline is rejected.",
			parameters: coursePlanInput,
			execute: serverExecute(
				"course_plan",
				coursePlanInput,
				async ({ action, course: requested, unitId, problemId, units, status, attempt, attempts, hint, solutionShown, lastCheck }) => {
					let courseId = resolveCourseId(ctx, requested);
					if (action === "status") {
						const course = ctx.courses.getCourse(courseId);
						if (!course) {
							return { ok: false, error: `No course "${courseId}" yet — call action "outline" first.` };
						}
						const progress = ctx.courses.readProgress(courseId);
						const completion = courseCompletion(course, progress);
						const step = nextStep(course, progress);
						return {
							ok: true,
							courseId,
							title: course.title,
							completion: `${completion.done}/${completion.total} problems`,
							remaining: formatMinutes(courseRemainingMinutes(course, progress)),
							nextStep: step ? { kind: step.kind, unitId: step.unitId, problemId: step.problemId, label: step.label } : null,
							problems: course.units.flatMap((unit) =>
								unit.problems.map((problem) => ({
									id: problem.id,
									unitId: unit.id,
									title: problem.title,
									status: progress[progressKey(unit.id, problem.id)]?.status ?? "todo",
									attempts: progress[progressKey(unit.id, problem.id)]?.attempts ?? 0,
								})),
							),
						};
					}
					if (action === "outline") {
						// The reference the learner gave: a catalogue id, a
						// course URL or a course name. A reference that names
						// a DIFFERENT course wins over the chat's binding.
						let targetId = courseId;
						let request: CourseRequest | undefined;
						if (requested?.trim()) {
							const resolved = await ctx.courses.resolveCourse(requested.trim());
							targetId = resolved.courseId;
							request = {
								courseId: resolved.courseId,
								ref: resolved.ref,
								source: resolved.source,
								title: resolved.title,
								...(resolved.edition ? { edition: resolved.edition } : {}),
							};
						}
						let course = ctx.courses.getCourse(targetId);
						if (!course || course.units.length === 0) {
							course = await ctx.courses.buildCourse(targetId, request);
						}
						ctx.courses.bindChat(ctx.chatId, { courseId: targetId });
						return {
							ok: true,
							...outlineOf(course),
							next:
								"Ask the learner TWO quick questions (ask_user_question, one per turn): (1) what they have already done with this material, " +
								"(2) their time budget and whether they want any video at all. Then write the plan and commit it.",
						};
					}
					// A reference that names a course the session is not on
					// (a URL, a name) resolves to its own id.
					if (!ctx.courses.getCourse(courseId) && requested?.trim()) {
						const resolved = await ctx.courses.resolveCourse(requested.trim());
						courseId = resolved.courseId;
					}
					const course = ctx.courses.getCourse(courseId);
					if (!course) {
						return { ok: false, error: `No course "${courseId}" yet — call action "outline" first.` };
					}
					ctx.courses.bindChat(ctx.chatId, { courseId });
					if (action === "notes") {
						const unit = findUnit(course, unitId, 0);
						if (!unit) return { ok: false, error: `No unit "${unitId}" in ${courseId}.` };
						const notes = await ctx.courses.unitNotes(courseId, unit);
						return {
							ok: true,
							unitId: unit.id,
							title: unit.title,
							notes: notes.slice(0, 24_000),
							truncated: notes.length > 24_000,
						};
					}
					if (action === "segments") {
						const unit = findUnit(course, unitId, 0);
						if (!unit) return { ok: false, error: `No unit "${unitId}" in ${courseId}.` };
						const timeline = await ctx.courses.unitTimeline(courseId, unit);
						return {
							ok: true,
							unitId: unit.id,
							title: unit.title,
							timeline: timeline.map((entry) => ({
								seconds: entry.seconds,
								time: formatTimestamp(entry.seconds),
								text: entry.text.slice(0, 220),
							})),
						};
					}
					if (action === "progress") {
						if (!problemId) return { ok: false, error: "progress needs a problemId." };
						const found = findProblem(course, problemId);
						if (!found) return { ok: false, error: `No problem "${problemId}" in ${courseId}.` };
						const key = progressKey(found.unit.id, found.problem.id);
						const current = ctx.courses.readProgress(courseId)[key];
						// The counts are absolute in the store, so the tool counts them here.
						const attemptCount =
							attempts !== undefined
								? Math.max(0, Math.round(attempts))
								: attempt
									? (current?.attempts ?? 0) + 1
									: (current?.attempts ?? 0);
						const hintsUsed = hint ? (current?.hintsUsed ?? 0) + 1 : (current?.hintsUsed ?? 0);
						// A passed (or submitted) problem is never downgraded by a later
						// failing check.
						const done = current?.status === "passed" || current?.status === "submitted";
						const nextStatus =
							done && status !== "passed" && status !== "submitted" ? current?.status : status;
						const entry = ctx.courses.updateProgress(courseId, {
							unitId: found.unit.id,
							problemId: found.problem.id,
							...(nextStatus !== undefined ? { status: nextStatus } : {}),
							attempts: attemptCount,
							hintsUsed,
							...(solutionShown !== undefined ? { solutionShown } : {}),
							...(lastCheck !== undefined ? { lastCheck } : {}),
						});
						return { ok: true, problemId: found.problem.id, unitId: found.unit.id, progress: entry };
					}
					if (action === "workspace") {
						if (!problemId) return { ok: false, error: "workspace needs a problemId." };
						const found = findProblem(course, problemId);
						if (!found) return { ok: false, error: `No problem "${problemId}" in ${courseId}.` };
						const prepared = await ctx.courses.prepareProblem(course, found.problem);
						const kind = graderOf(found.problem);
						return {
							ok: true,
							problemId: found.problem.id,
							folder: prepared.folder,
							created: prepared.created,
							files: found.problem.files.map((file) => file.name),
							grader: kind,
							graderLabel: graderLabel(found.problem),
							check: `check ${found.problem.id}`,
							note:
								kind === "ai-rubric"
									? "This problem has no autograder: the Check button (and your own review) reads the work against the assignment. Say 'check it' and I will grade it."
									: kind === "none"
										? "This problem has no autograder — read the spec and answer in the chat."
										: "Grade it with the course tool (cli_course): 'check <problem>'.",
						};
					}
					// commit
					if (!units || units.length === 0) {
						return { ok: false, error: "commit needs the units to write (lesson, videos, problems, estimates)." };
					}
					const problems: string[] = [];
					const nextUnits = course.units.map((unit) => ({ ...unit }));
					for (const [position, payload] of units.entries()) {
						const index = payload.id ? nextUnits.findIndex((u) => u.id === payload.id) : position;
						if (index < 0 || index >= nextUnits.length) {
							problems.push(`No unit "${payload.id}" in this course (call "outline" for the ids).`);
							continue;
						}
						const unit = nextUnits[index]!;
						if (payload.lesson !== undefined) unit.lesson = payload.lesson;
						if (payload.estimateMinutes !== undefined) unit.estimateMinutes = Math.max(0, Math.round(payload.estimateMinutes));
						if (payload.videos !== undefined) {
							const segments: CourseVideoSegment[] = payload.videos.map((video) => ({
								title: video.title,
								youtubeId: video.youtubeId,
								...(video.startSeconds !== undefined ? { startSeconds: Math.floor(video.startSeconds) } : {}),
								...(video.note !== undefined ? { note: video.note } : {}),
							}));
							const videoProblems = await validateVideos(ctx, course, unit, segments);
							problems.push(...videoProblems);
							if (videoProblems.length === 0) unit.videos = segments;
						}
						if (payload.problems !== undefined) {
							const chosen: CourseProblem[] = [];
							for (const wanted of payload.problems) {
								const problem = unit.problems.find((p) => p.id === wanted.id);
								if (!problem) {
									problems.push(`Unit "${unit.id}" has no problem "${wanted.id}" (call "outline" for the ids).`);
									continue;
								}
								chosen.push({
									...problem,
									...(wanted.estimateMinutes !== undefined ? { estimateMinutes: Math.max(0, Math.round(wanted.estimateMinutes)) } : {}),
								});
							}
							unit.problems = chosen;
						}
					}
					if (problems.length > 0) {
						return { ok: false, error: problems.join("\n") };
					}
					const saved = ctx.courses.saveCourse({ ...course, units: nextUnits, updatedAt: new Date().toISOString() });
					return {
						ok: true,
						courseId: saved.id,
						written: nextUnits.map((unit) => ({
							id: unit.id,
							lesson: unit.lesson.trim().length > 0,
							videos: unit.videos.length,
							problems: unit.problems.length,
							estimateMinutes: unit.estimateMinutes,
						})),
					};
				},
				{ timeoutMs: 240_000 },
			),
		},
	};
}
