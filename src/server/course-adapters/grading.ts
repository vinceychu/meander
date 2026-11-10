/**
 * THE GRADERS (server side) — running the course's own checks (2026-11-09).
 *
 * Two paths, in this order:
 *
 *   1. THE COURSE'S OWN GRADER — the `ok` client (CS61A's) or the course's
 *      test suite (pytest / npm test / make test / cargo test / go test).
 *      The command runs inside the sandbox, with a timeout.
 *   2. THE RUBRIC — nothing to run: the tutor model reads the learner's
 *      files against the assignment's rubric and answers in the same
 *      [ok]/[FAIL] format. It is labelled "AI-reviewed, not an official
 *      autograder" everywhere, because it is not one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runSubagent } from "../../agent/subagents/pi-run.ts";
import { checksToLines, parseTestOutput, summaryLine } from "../../core/course-graders.ts";
import type { CourseGrade, GraderKind } from "../../core/course-adapters.ts";
import type { CourseProblem } from "../../core/courses.ts";
import { engineForRole } from "./model.ts";
import { readEnvFile, runSandboxed } from "../toolchain.ts";

/** How long a test run may take. */
const GRADER_TIMEOUT_MS = 180_000;

/** Split a grader command into its argv (no shell — the commands are ours). */
export function splitCommand(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** How a command grader runs. */
export interface CommandGraderOptions {
	/** The folder (relative to the problem's folder) the course's code — and
	 *  therefore its grader — lives in ("lab01/"). Empty = the problem's
	 *  folder itself. */
	workDir?: string;
	/** Extra environment (the course's own `.env` is read by default). */
	env?: Record<string, string>;
}

/**
 * Run the course's own grader and read its verdict.
 *
 * The command runs where the course's code lives — a course that hands
 * out its lab in a subfolder grades inside that subfolder — and with the
 * course's own environment (its `.env` sets the PYTHONPATH a vendored
 * pytest needs).
 *
 * A runner that produces no per-test lines at all (the command is
 * missing, the suite does not exist) is NOT a verdict: the caller keeps
 * the old status rather than marking the problem done. When the runner
 * printed nothing but exited 0, the run itself is the single check.
 */
export async function runCommandGrader(
	command: string,
	folder: string,
	grader: GraderKind,
	opts: CommandGraderOptions = {},
): Promise<CourseGrade> {
	const argv = splitCommand(command);
	if (argv.length === 0) {
		return { ok: false, lines: [], passed: 0, total: 0, causes: [], grader, output: "no grader command" };
	}
	const cwd = opts.workDir ? path.join(/*turbopackIgnore: true*/ folder, opts.workDir) : folder;
	const result = await runSandboxed(argv[0]!, argv.slice(1), {
		cwd,
		writable: [folder],
		timeoutMs: GRADER_TIMEOUT_MS,
		env: { ...readEnvFile(cwd), ...opts.env },
	});
	const checks = parseTestOutput(result.output);
	let lines = checksToLines(checks);
	let passed = checks.filter((check) => check.ok).length;
	let total = checks.length;
	if (total === 0) {
		// No per-test lines: the run itself is one check (this is what a
		// `make test` target that prints nothing looks like).
		lines = [result.ok ? "[ok] the course's own checks" : "[FAIL] the course's own checks"];
		passed = result.ok ? 1 : 0;
		total = 1;
	}
	const output = `${lines.join("\n")}\n${summaryLine(passed, total)}\n${result.output}`.trim();
	return {
		ok: passed === total && total > 0,
		lines,
		passed,
		total,
		causes: checks.filter((check) => !check.ok).map((check) => check.cause ?? check.name),
		grader,
		output,
	};
}

// ─── the rubric ─────────────────────────────────────────────────────────────

/** The label every rubric grade carries — it is NOT an autograder. */
export const RUBRIC_LABEL = "AI-reviewed, not an official autograder";

const RUBRIC_SYSTEM = `You are a tutor grading a learner's work against an assignment.
You are NOT an autograder: you judge the work against the requirements the assignment states, and you say so.

Answer with one line per requirement, in exactly this format:
[ok] <the requirement, briefly>
[FAIL] <the requirement, briefly>
        <what is wrong, in one line, pointing at the file and the line>

Rules:
- one line per requirement the assignment states; no requirement, no line;
- a requirement passes only when the learner's code clearly does it;
- never rewrite the learner's code and never give a full solution;
- no prose before or after the lines.`;

export interface RubricGradeOptions {
	/** The problem being graded. */
	problem: CourseProblem;
	/** The problem's folder (the learner's work). */
	folder: string;
	/** The problem's spec (the assignment the work is judged against). */
	spec: string;
	/** The test seam (the model that reads the work). */
	engine?: ReturnType<typeof engineForRole>;
}

/** The learner's files, as the rubric prompt shows them. */
function learnerFiles(folder: string, budget = 24_000): string {
	let out = "";
	let entries: string[];
	try {
		entries = fs.readdirSync(folder);
	} catch {
		return "";
	}
	for (const name of entries.sort()) {
		if (name.startsWith(".") || name === "README.md") continue;
		let content: string;
		try {
			content = fs.readFileSync(path.join(folder, name), "utf-8");
		} catch {
			continue;
		}
		if (content.length > 8000) content = `${content.slice(0, 8000)}\n… (truncated)`;
		const chunk = `\n--- ${name} ---\n${content}\n`;
		if (out.length + chunk.length > budget) break;
		out += chunk;
	}
	return out;
}

/**
 * Grade the learner's work against the assignment's rubric.
 *
 * The verdict is the tutor's judgment, not the course's: the output says
 * so in its first line, so nobody can mistake it for a real autograder.
 */
export async function runRubricGrader(opts: RubricGradeOptions): Promise<CourseGrade> {
	const files = learnerFiles(opts.folder);
	if (!files.trim()) {
		return {
			ok: false,
			lines: ["[FAIL] there is nothing to review yet"],
			passed: 0,
			total: 1,
			causes: ["the problem's folder is empty"],
			grader: "ai-rubric",
			output: `${RUBRIC_LABEL}\n[FAIL] there is nothing to review yet`,
		};
	}
	const engine = opts.engine ?? engineForRole("teacher");
	if (!engine) {
		return {
			ok: false,
			lines: ["[FAIL] no model is configured to review the work"],
			passed: 0,
			total: 1,
			causes: ["no model configured (settings → models)"],
			grader: "ai-rubric",
			output: `${RUBRIC_LABEL}\n[FAIL] no model is configured to review the work`,
		};
	}
	const prompt = [
		`# The assignment (${opts.problem.title})`,
		"",
		opts.spec.slice(0, 12_000),
		"",
		"# The learner's work",
		files,
		"",
		"Grade each requirement the assignment states. One [ok]/[FAIL] line per requirement.",
	].join("\n");
	try {
		const { text } = await runSubagent([], {
			role: "teacher",
			engine,
			systemPrompt: RUBRIC_SYSTEM,
			prompt,
			maxTurns: 2,
		});
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^\[(ok|FAIL)\]/.test(line));
		if (lines.length === 0) {
			return {
				ok: false,
				lines: ["[FAIL] the review did not answer in the expected format"],
				passed: 0,
				total: 1,
				causes: [text.slice(0, 400)],
				grader: "ai-rubric",
				output: `${RUBRIC_LABEL}\n${text}`.trim(),
			};
		}
		const passed = lines.filter((line) => line.startsWith("[ok]")).length;
		const total = lines.length;
		const output = `${RUBRIC_LABEL}\n${lines.join("\n")}\n${summaryLine(passed, total)}`;
		return {
			ok: passed === total,
			lines,
			passed,
			total,
			causes: lines.filter((line) => line.startsWith("[FAIL]")).map((line) => line.replace(/^\[FAIL\]\s*/, "")),
			grader: "ai-rubric",
			output,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			lines: ["[FAIL] the review could not be run"],
			passed: 0,
			total: 1,
			causes: [message],
			grader: "ai-rubric",
			output: `${RUBRIC_LABEL}\n[FAIL] the review could not be run\n${message}`,
		};
	}
}
