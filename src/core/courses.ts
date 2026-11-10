/**
 * COURSES — the domain shape of "take a whole external course" (2026-11-09).
 *
 * A COURSE is a syllabus of UNITS; a unit is a condensed lesson + optional
 * video segments + problem sets. The model is deliberately generic: CS50x is
 * the first fully supported course, but nothing here knows about C or
 * Harvard — the course-specific knowledge lives in the fetched pages and in
 * the plan the teacher writes.
 *
 * Browser-safe: pure logic + types, no node builtins, no network. The store
 * adapter (src/store/courses.ts) and the fetcher (src/server/courses.ts)
 * code against these shapes.
 */

/** How a problem is done: in the app's workspace, or in VS Code. */
export type ProblemMode = "app" | "vscode";

/** Where a problem stands. `submitted` means the learner ran submit50 himself. */
export type ProblemStatus = "todo" | "in-progress" | "passed" | "submitted";

/** One watchable slice of a lecture. `startSeconds` is a REAL chapter
 *  timestamp read off the lecture's subtitle track — never invented; the
 *  plan tool rejects a segment whose timestamp is not in the fetched
 *  timeline. */
export interface CourseVideoSegment {
	title: string;
	/** The lecture's YouTube id (e.g. "UuIEbpQms8o"). */
	youtubeId: string;
	/** Chapter start, in seconds. Absent = the segment starts at 0. */
	startSeconds?: number;
	/** Why this slice is worth the minutes. */
	note?: string;
}

/** One file of a problem's workspace (the starter set the learner edits). */
export interface CourseFile {
	name: string;
	content: string;
	/** The editor's language id ("c", "python", "sql", "html", "text"). */
	language: string;
}

/**
 * How a problem is graded.
 *
 *   check50     the CS50 family's own grader (`check50 --local <slug>`)
 *   autograder  the course's own client (`python3 ok --local` for CS61A)
 *   tests       the course's test suite (pytest / npm test / make test /
 *               cargo test / go test)
 *   ai-rubric   nothing to run: the tutor reviews the work against the
 *               assignment's rubric — labelled as NOT an official autograder
 *   none        nothing to run: the learner reads and answers
 */
export type GraderKind = "check50" | "autograder" | "tests" | "ai-rubric" | "none";

/** One problem (a CS50 "less"/"more" pair is two problems). */
export interface CourseProblem {
	/** Stable id inside the course ("mario-less"). The workspace folder name. */
	id: string;
	/** The unit this problem belongs to. */
	unitId: string;
	title: string;
	/** The check50 slug ("cs50/problems/2026/x/mario/less") — the grader's id. */
	slug: string;
	/** The spec page (what the learner reads). */
	specUrl: string;
	/** The videos the spec embeds (the problem's demo and its walkthrough).
	 *  Their `startSeconds` are the spec's own chapter marks — real, unlike
	 *  anything the tutor might make up. */
	videoEmbeds?: Array<{ youtubeId: string; startSeconds?: number }>;
	/** "less" = the easier variant, "more" = the harder one, "standard" = one variant. */
	variant: "less" | "more" | "standard";
	language: CourseFile["language"];
	/** Distribution archives to fetch and unpack into the workspace (may be empty). */
	distributionUrls: string[];
	/** The starter files (synthesized from the spec when the course ships no zip). */
	files: CourseFile[];
	estimateMinutes: number;
	/** How this problem is done — defaults to the course setting. */
	mode?: ProblemMode;
	/** How this problem is graded (absent = what its shape implies). */
	grader?: GraderKind;
	/** The command that runs the course's own grader (the `ok` client, the
	 *  test suite) — absent when the course ships none. */
	graderCommand?: string;
	/** The folder (relative to the problem's folder) the course's code — and
	 *  therefore its grader — lives in ("lab01/"). Empty = the problem's
	 *  folder itself. */
	graderWorkDir?: string;
	/** The starter repository (cloned shallow into the workspace). */
	repoUrl?: string;
}

/** One grader's verdict — the normalized shape every adapter returns. */
export interface CourseGrade {
	/** True when every check passed (and there was at least one). */
	ok: boolean;
	/** The [ok]/[FAIL] lines — what the tutor coaches from. */
	lines: string[];
	/** The checks that passed. */
	passed: number;
	/** The checks that ran. */
	total: number;
	/** The failing checks' causes (the grader's own words). */
	causes: string[];
	/** Which grader produced this verdict. */
	grader: GraderKind;
	/** The grader's raw output (for the app's output pane). */
	output: string;
}

/** What an adapter needs to build a course. */
export interface CourseRequest {
	/** The course id on disk (the folder name). */
	courseId: string;
	/** The reference the learner gave (a catalogue id, a URL, a name). */
	ref: string;
	/** The course's home page (its site). */
	source: string;
	/** The page that lists the units (when the course has one). */
	indexUrl?: string;
	/** The display title. */
	title: string;
	/** The course's own edition label. */
	edition?: string;
}

/** A resolved course reference — what the catalogue, a URL or a name gives. */
export interface ResolvedCourse {
	/** The course id on disk. */
	courseId: string;
	/** The reference the learner gave. */
	ref: string;
	/** The course's display title. */
	title: string;
	/** The course's home page. */
	source: string;
	/** The edition label, when the course states one. */
	edition?: string;
	/** Which adapter handles it ("cs50", "generic"). */
	adapter: string;
}

/** One unit (a week, a module, a chapter — whatever the course calls it). */
export interface CourseUnit {
	id: string;
	/** Position in the course (0-based). */
	index: number;
	title: string;
	/** The unit's one-paragraph summary (the course page's own summary line). */
	summary: string;
	/** The notes page the lesson was condensed from. */
	notesUrl: string;
	/** The unit's own page in the course (where its lecture + subtitles live). */
	pageUrl?: string;
	/** The lecture's own video id (the player on the unit page). A video
	 *  segment may point at this video — and at nothing else. */
	videoId?: string;
	/** The condensed lesson the teacher wrote (markdown). */
	lesson: string;
	/** The watchable slices (empty when the learner asked to skip videos). */
	videos: CourseVideoSegment[];
	estimateMinutes: number;
	problems: CourseProblem[];
}

/** Per-course knobs the learner can change. */
export interface CourseSettings {
	/** The default way a problem is done; a problem may override it. */
	defaultMode: ProblemMode;
	/** False = the learner asked to skip videos (notes-based lessons only). */
	videos: boolean;
}

/** A course record — the plan, persisted beside the chats. */
export interface Course {
	id: string;
	title: string;
	/** Where the syllabus came from (the course's site). */
	source: string;
	/** The course's own edition label ("2026"). */
	edition?: string;
	createdAt: string;
	updatedAt: string;
	settings: CourseSettings;
	units: CourseUnit[];
}

/** One problem's progress row. */
export interface CourseProgressEntry {
	courseId: string;
	unitId: string;
	problemId: string;
	status: ProblemStatus;
	/** How many times the learner checked this problem. */
	attempts: number;
	/** How many graded hints the tutor gave. */
	hintsUsed: number;
	/** True once a full solution was shown (the tutor's last resort). */
	solutionShown: boolean;
	/** ISO stamp of the last check. */
	lastCheck?: string;
	updatedAt: string;
}

/** The progress map of one course: problemId → entry. */
export type CourseProgress = Record<string, CourseProgressEntry>;

/** The key a progress row is filed under. */
export function progressKey(unitId: string, problemId: string): string {
	return `${unitId}/${problemId}`;
}

/** The default course settings: notes-first, no videos, work in the app. */
export function defaultCourseSettings(): CourseSettings {
	return { defaultMode: "app", videos: false };
}

/** A fresh progress row. */
export function newProgressEntry(courseId: string, unitId: string, problemId: string): CourseProgressEntry {
	return {
		courseId,
		unitId,
		problemId,
		status: "todo",
		attempts: 0,
		hintsUsed: 0,
		solutionShown: false,
		updatedAt: new Date().toISOString(),
	};
}

/** Merge a progress update into a map (pure — the store persists the result).
 *  `attempts` is ABSOLUTE (the caller counts the checks), so a merge never
 *  loses a count and never double-counts one. */
export function applyProgress(
	progress: CourseProgress,
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
): CourseProgress {
	const key = progressKey(update.unitId, update.problemId);
	const prev = progress[key];
	const entry: CourseProgressEntry = prev
		? { ...prev }
		: newProgressEntry(courseId, update.unitId, update.problemId);
	entry.courseId = courseId;
	entry.status = update.status ?? entry.status;
	entry.attempts = update.attempts ?? entry.attempts;
	entry.hintsUsed = Math.max(entry.hintsUsed, update.hintsUsed ?? 0);
	entry.solutionShown = entry.solutionShown || update.solutionShown === true;
	if (update.lastCheck !== undefined) entry.lastCheck = update.lastCheck;
	entry.updatedAt = now;
	return { ...progress, [key]: entry };
}

/** The mode a problem is done in: its own override, else the course default. */
export function problemMode(course: Course, problem: CourseProblem): ProblemMode {
	return problem.mode ?? course.settings.defaultMode;
}

/** Every problem of the course, in unit order. */
export function courseProblems(course: Course): Array<{ unit: CourseUnit; problem: CourseProblem }> {
	const out: Array<{ unit: CourseUnit; problem: CourseProblem }> = [];
	for (const unit of course.units) for (const problem of unit.problems) out.push({ unit, problem });
	return out;
}

/** The course's completion (0..1) over its problems. */
export function courseCompletion(course: Course, progress: CourseProgress): { done: number; total: number; ratio: number } {
	const all = courseProblems(course);
	const done = all.filter(({ unit, problem }) => {
		const entry = progress[progressKey(unit.id, problem.id)];
		return entry?.status === "passed" || entry?.status === "submitted";
	}).length;
	const total = all.length;
	return { done, total, ratio: total ? done / total : 0 };
}

/** The course's remaining estimated minutes (the units not yet finished). */
export function courseRemainingMinutes(course: Course, progress: CourseProgress): number {
	let minutes = 0;
	for (const unit of course.units) {
		const unitProblems = unit.problems;
		const unitDone = unitProblems.length > 0 && unitProblems.every((p) => {
			const entry = progress[progressKey(unit.id, p.id)];
			return entry?.status === "passed" || entry?.status === "submitted";
		});
		if (!unitDone) minutes += unit.estimateMinutes;
	}
	return minutes;
}

/** The one thing to do next — the sidebar's "next step" line. */
export function nextStep(course: Course, progress: CourseProgress): { kind: "lesson" | "problem" | "done"; unitId: string; problemId?: string; label: string } | null {
	for (const unit of course.units) {
		for (const problem of unit.problems) {
			const entry = progress[progressKey(unit.id, problem.id)];
			if (entry?.status === "passed" || entry?.status === "submitted") continue;
			return {
				kind: "problem",
				unitId: unit.id,
				problemId: problem.id,
				label: problem.title,
			};
		}
		if (!unit.lesson.trim()) {
			return { kind: "lesson", unitId: unit.id, label: unit.title };
		}
	}
	return null;
}

/** The lesson-only next step (a course with no problems yet). */
export function nextLesson(course: Course): CourseUnit | null {
	return course.units.find((u) => !u.lesson.trim()) ?? null;
}

/** A course id: stable, filesystem-safe, human-readable ("cs50x"). */
export function courseIdFor(slug: string): string {
	const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return clean || "course";
}

/** The YouTube watch URL for a segment (with its chapter timestamp). */
export function segmentUrl(segment: CourseVideoSegment): string {
	const base = `https://www.youtube.com/watch?v=${segment.youtubeId}`;
	if (segment.startSeconds === undefined || segment.startSeconds <= 0) return base;
	return `${base}&t=${Math.floor(segment.startSeconds)}s`;
}

/** "1h 20m" / "45m" — the estimate format the UI and the agent share. */
export function formatMinutes(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** Which course (and problem) a chat is working on. */
export interface ChatBinding {
	courseId: string;
	/** The problem the learner is on, when one is open. */
	problemId?: string;
}

/**
 * THE COURSE SERVICE — what the agent tool may ask the server for. The
 * interface lives here (core is the shared vocabulary); the implementation
 * lives in src/server/courses.ts, where the network and the filesystem are.
 */
export interface CourseService {
	/** Every course on disk. */
	listCourses(): Course[];
	/** One course (null when it does not exist). */
	getCourse(courseId: string): Course | null;
	/** Resolve a reference (a catalogue id, a course URL, a course name). */
	resolveCourse(ref: string): Promise<ResolvedCourse>;
	/** Fetch the syllabus and write the course record (the pages are cached). */
	buildCourse(courseId: string, request?: CourseRequest): Promise<Course>;
	/** The unit's notes markdown. */
	unitNotes(courseId: string, unit: CourseUnit): Promise<string>;
	/** The lecture's sampled timeline — the REAL timestamps a segment may use. */
	unitTimeline(courseId: string, unit: CourseUnit): Promise<Array<{ seconds: number; text: string }>>;
	/** Prepare a problem's folder (starter files + the workspace catalogue). */
	prepareProblem(course: Course, problem: CourseProblem): Promise<{ folder: string; created: string[] }>;
	/** Grade the learner's work in the problem's folder. */
	gradeProblem(course: Course, problem: CourseProblem): Promise<CourseGrade>;
	/** The problem's folder path. */
	problemFolder(courseId: string, problemId: string): string;
	/** The course's progress map. */
	readProgress(courseId: string): CourseProgress;
	/** Merge a progress update and persist it. */
	updateProgress(
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
	): CourseProgressEntry;
	/** Write the course record. */
	saveCourse(course: Course): Course;
	/** The chat's course binding. */
	chatBinding(chatId: string): ChatBinding | null;
	/** Bind a chat to a course (and optionally a problem). */
	bindChat(chatId: string, binding: ChatBinding): void;
}
