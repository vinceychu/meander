/**
 * COURSE ADAPTERS — the seam that makes "learn ANY course" work
 * (2026-11-09).
 *
 * A COURSE is a syllabus of units; a unit is a lesson + problem sets. The
 * shape is generic (src/core/courses.ts); what used to be CS50-only —
 * the HTML parsers, the check50 grading, the cs50 tool — now lives behind
 * one ADAPTER interface, so a new course is a new adapter, not a new
 * rewrite of the flow.
 *
 * Two adapters ship:
 *   - `cs50`    the CS50 family (CS50x, CS50P, CS50AI, CS50W, CS50SQL,
 *               CS50R, CS50 Cybersecurity): the same site structure, the
 *               same check50 grading, the slugs read off the spec pages.
 *   - `generic` the fallback for any other course page: the page (and the
 *               syllabus/schedule pages it links) is crawled, the model
 *               extracts the outline, and the starter code comes from the
 *               course's own zip or repository.
 *
 * Browser-safe: pure logic + types, no node builtins, no network. The
 * adapters themselves live in src/server/course-adapters/ (network + fs).
 */

import type { CourseGrade, CourseProblem, CourseRequest, CourseUnit, GraderKind, ResolvedCourse } from "./courses.ts";

// The shared vocabulary lives in core/courses.ts (the domain model); it is
// re-exported here so the adapters and their callers can take it from the
// seam they already import.
export type { CourseGrade, CourseRequest, GraderKind, ResolvedCourse } from "./courses.ts";

/**
 * How a problem is graded — the label the course page shows and the path
 * the grader takes. The kinds themselves live in core/courses.ts (the
 * domain vocabulary every layer shares).
 */

/** The label the course page shows for each grader kind. */
export const GRADER_LABELS: Readonly<Record<GraderKind, string>> = {
	check50: "Official check50",
	autograder: "Course autograder",
	tests: "Tests",
	"ai-rubric": "AI-reviewed",
	none: "No autograder",
};

/** The label for a problem (its own grader, else what its shape implies). */
export function graderLabel(problem: Partial<Pick<CourseProblem, "grader" | "slug">>): string {
	return GRADER_LABELS[graderOf(problem)];
}

/**
 * The grader a problem is actually graded by.
 *
 * A problem that says nothing is graded the way its shape implies: a
 * check50 slug means check50 (that is how every CS50 problem has always
 * been graded), no slug and no command means nothing to run.
 */
export function graderOf(problem: Partial<Pick<CourseProblem, "grader" | "slug" | "graderCommand">>): GraderKind {
	if (problem.grader) return problem.grader;
	if (problem.slug) return "check50";
	if (problem.graderCommand) return "tests";
	return "none";
}

/** One grader's verdict — the normalized shape every adapter returns. */

/** The course's outline — what an adapter builds. */
export interface CourseOutline {
	/** The course's display title. */
	title: string;
	/** Where the course lives (its site). */
	source: string;
	/** The course's own edition label ("2026"). */
	edition?: string;
	/** The units, in the course's own order. */
	units: CourseUnit[];
}

/**
 * THE COURSE ADAPTER — one course family, one implementation.
 *
 * The interface is the whole point: the flow above it (the plan tool, the
 * tutor, the UI) never learns whether the course is CS50x or something
 * nobody has heard of.
 */
export interface CourseAdapter {
	/** The adapter's id ("cs50", "generic"). */
	readonly id: string;
	/** Does this adapter handle the given reference (a URL or a name)? */
	detect(ref: string): boolean;
	/** Build the course's outline: the units, their notes, their problems. */
	outline(request: CourseRequest): Promise<CourseOutline>;
	/** The problem's spec — the markdown the learner reads. */
	problemSpec(request: CourseRequest, problem: CourseProblem): Promise<string>;
	/** Set the problem's folder up: the starter files, the starter repo.
	 *  The grader the course's own files give away is reported back (the
	 *  server records it on the problem, so the label and the check agree). */
	prepare(
		request: CourseRequest,
		problem: CourseProblem,
		folder: string,
	): Promise<{ created: string[]; grader?: GraderKind; graderCommand?: string; graderWorkDir?: string }>;
	/** Grade the learner's work in the folder. */
	grade(request: CourseRequest, problem: CourseProblem, folder: string): Promise<CourseGrade>;
}

// ─── the verdict reader ─────────────────────────────────────────────────────

/** What the grader's output says about the work. */
export interface CheckVerdict {
	/** The checks that ran. */
	total: number;
	/** The checks that passed. */
	passed: number;
	/** The failing checks' names. */
	failed: string[];
}

/**
 * Read the grader's [ok]/[FAIL] lines into a verdict.
 *
 * The lines are the learner tool's own format ("[ok] compiles",
 * "[FAIL] rejects a height of 0" and a "3/10 checks passed" summary) —
 * the same text the tutor coaches from, so the app and the tutor read one
 * thing. A run that produced no lines at all (the grader is missing, the
 * program does not compile) is no verdict — the caller keeps the old
 * status rather than marking the problem done.
 */
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

/** The [ok]/[FAIL] lines of a grader's output, in order. */
export function checkLines(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^\[(ok|FAIL)\]/.test(line));
}

/** A verdict from a set of lines (the generic graders build their own). */
export function verdictFromLines(lines: string[], summary?: string): CheckVerdict {
	let passed = 0;
	const failed: string[] = [];
	for (const line of lines) {
		const match = /^\[(ok|FAIL)\]\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		if (match[1] === "ok") passed++;
		else failed.push((match[2] ?? "").trim());
	}
	const count = summary ? /(\d+)\/(\d+) checks passed/.exec(summary) : null;
	return count
		? { total: Number(count[2]), passed: Number(count[1]), failed }
		: { total: passed + failed.length, passed, failed };
}
