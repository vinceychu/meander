/**
 * THE GRADERS — how a problem is checked outside CS50 (2026-11-09).
 *
 * The CS50 family grades with check50. Every other course grades with
 * whatever the course itself ships, in this order of preference:
 *
 *   1. THE COURSE'S OWN AUTOGRADER — the `ok` client (CS61A's) runs
 *      `python3 ok --local` with no login.
 *   2. THE COURSE'S TESTS — pytest (`tests/` or `test_*.py`), `npm test`,
 *      `make test`, `cargo test`, `go test`.
 *   3. THE RUBRIC — nothing to run: the tutor reviews the learner's files
 *      against the assignment's rubric. This is NOT an autograder and is
 *      labelled as such everywhere it appears.
 *
 * Pure: the detection reads a list of file names, the parser reads the
 * runner's output. Both are testable without a filesystem or a network.
 */

import type { GraderKind } from "./course-adapters.ts";

/** A detected grader: what it is and the command that runs it. */
export interface DetectedGrader {
	/** Which kind of grader it is. */
	grader: GraderKind;
	/** The command that runs it (in the problem's folder). */
	graderCommand: string;
	/** Why it was chosen (the file that gave it away). */
	because: string;
	/** The folder (relative to the problem's folder) the course's code —
	 *  and therefore the grader — lives in. Empty = the problem's folder
	 *  itself. A course that hands out its starter code in a subfolder
	 *  ("lab01/") grades inside that folder, not beside it. */
	workDir: string;
}

/** The file names a folder holds (relative, "/" separated). */
export type FileList = readonly string[];

/** Does the list hold a file with this name (in any folder)? */
function hasFile(files: FileList, name: string): boolean {
	return files.some((file) => file === name || file.endsWith(`/${name}`));
}

/** Does the list hold a file matching this pattern (in any folder)? */
function hasMatch(files: FileList, pattern: RegExp): boolean {
	return files.some((file) => pattern.test(file));
}

/**
 * The folder the grader runs in — the folder the course's own code lives
 * in, relative to the problem's folder.
 *
 * A test suite sits in a "tests/" folder, so the grader runs in the
 * folder ABOVE it ("lab01/"); a file at the top ("ok", "Makefile") runs in
 * the problem's folder itself.
 */
function workDirOf(files: FileList, isGraderFile: (file: string) => boolean): string {
	for (const file of files) {
		if (file.endsWith("/")) continue;
		if (!isGraderFile(file)) continue;
		const segments = file.split("/");
		const suite = segments.findIndex((segment) => segment === "tests" || segment === "test");
		if (suite >= 0) return segments.slice(0, suite).join("/");
		if (segments.length > 1) return segments.slice(0, -1).join("/");
		return "";
	}
	return "";
}

/** Is this file a pytest suite (or a test file)? */
function isPytestFile(file: string): boolean {
	return /(^|\/)tests?\//.test(file) || /(^|\/)test_[^/]+\.py$/.test(file);
}

/**
 * The grader a problem's folder ships with — null when it ships none
 * (the rubric then grades it).
 *
 * The order is the preference order: the course's own autograder first
 * (it is the course's own truth), then its test suite.
 */
export function detectGrader(files: FileList): DetectedGrader | null {
	// 1. the course's own autograder (the `ok` client CS61A ships).
	if (hasFile(files, "ok") || hasFile(files, "ok.py")) {
		return {
			grader: "autograder",
			graderCommand: "python3 ok --local",
			because: "the course ships its own `ok` autograder",
			workDir: workDirOf(files, (file) => file === "ok" || file === "ok.py" || file.endsWith("/ok") || file.endsWith("/ok.py")),
		};
	}
	// 2. pytest. The run is verbose on purpose: one line per test is what
	// the [ok]/[FAIL] lines are read from.
	if (hasMatch(files, /(^|\/)tests?\//) || hasMatch(files, /(^|\/)test_[^/]+\.py$/)) {
		return {
			grader: "tests",
			graderCommand: "python3 -m pytest -v",
			because: "the course ships a pytest suite",
			workDir: workDirOf(files, isPytestFile),
		};
	}
	// 3. the other test runners.
	if (hasFile(files, "package.json")) {
		return {
			grader: "tests",
			graderCommand: "npm test --silent",
			because: "the course ships a package.json test script",
			workDir: workDirOf(files, (file) => file.endsWith("package.json")),
		};
	}
	if (hasFile(files, "Makefile") || hasFile(files, "makefile")) {
		return {
			grader: "tests",
			graderCommand: "make test",
			because: "the course ships a Makefile",
			workDir: workDirOf(files, (file) => file.endsWith("Makefile") || file.endsWith("makefile")),
		};
	}
	if (hasFile(files, "Cargo.toml")) {
		return {
			grader: "tests",
			graderCommand: "cargo test",
			because: "the course ships a Cargo project",
			workDir: workDirOf(files, (file) => file.endsWith("Cargo.toml")),
		};
	}
	if (hasFile(files, "go.mod")) {
		return {
			grader: "tests",
			graderCommand: "go test ./...",
			because: "the course ships a Go module",
			workDir: workDirOf(files, (file) => file.endsWith("go.mod")),
		};
	}
	return null;
}

/** One parsed check line. */
export interface ParsedCheck {
	ok: boolean;
	/** The check's name. */
	name: string;
	/** The runner's own words about a failure. */
	cause?: string;
}

/**
 * The failure details pytest prints under "FAILURES" — the assertion the
 * learner's code actually tripped over.
 *
 * The per-test line ("tests/test_x.py::test_counts FAILED") says THAT a
 * test failed; the "E   assert 1 == 2" line says WHY. The coach needs the
 * second one, so it is read here and attached to the failure it belongs to.
 */
function pytestFailureDetails(output: string): Map<string, string> {
	const details = new Map<string, string>();
	const lines = output.split("\n");
	const start = lines.findIndex((line) => /=+\s*FAILURES\s*=+/.test(line));
	if (start < 0) return details;
	let name = "";
	let block: string[] = [];
	const flush = (): void => {
		if (!name) return;
		const causes = block.filter((line) => /^\s*E\s+\S/.test(line)).map((line) => line.trim());
		if (causes.length) details.set(name, causes.join(" "));
	};
	for (const line of lines.slice(start + 1)) {
		if (/={3,}.*={3,}/.test(line) && !/^\s*E\s/.test(line)) {
			flush();
			break;
		}
		const header = /^_{2,}\s*(.+?)\s*_{2,}$/.exec(line.trim());
		if (header) {
			flush();
			name = header[1]!.trim();
			block = [];
			continue;
		}
		block.push(line);
	}
	flush();
	return details;
}

/**
 * Read a test runner's output into the [ok]/[FAIL] lines the tutor reads.
 *
 * The runners disagree about everything except the shape of a failure, so
 * the patterns are matched one by one: pytest's "PASSED"/"FAILED", the TAP
 * lines node's test runner prints, cargo's "test x ... ok", go's
 * "--- PASS:", and the check marks jest and vitest print.
 */
export function parseTestOutput(output: string): ParsedCheck[] {
	const out: ParsedCheck[] = [];
	const lines = output.split("\n");
	const details = pytestFailureDetails(output);
	for (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		// pytest: "tests/test_x.py::test_name PASSED   [ 33%]"
		// (pytest prints these in CAPS — a lowercase "passed" is its summary
		// line, not a test.)
		let match = /^(.+?)\s+(PASSED|FAILED|ERROR|XFAIL|XPASS)\b/.exec(text);
		if (match) {
			const ok = match[2] === "PASSED" || match[2] === "XPASS";
			const name = match[1]!.trim();
			const detail = details.get(name.split("::").pop() ?? name);
			out.push({ ok, name, ...(ok ? {} : { cause: detail ?? text }) });
			continue;
		}
		// cargo: "test module::name ... ok"
		match = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\b/i.exec(text);
		if (match) {
			const ok = match[2]!.toLowerCase() === "ok";
			out.push({ ok, name: match[1]!.trim(), ...(ok ? {} : { cause: text }) });
			continue;
		}
		// go: "--- PASS: TestName (0.00s)"
		match = /^---\s+(PASS|FAIL|SKIP):\s*(.+?)(?:\s+\([^)]*\))?$/i.exec(text);
		if (match) {
			const ok = match[1]!.toUpperCase() === "PASS";
			out.push({ ok, name: match[2]!.trim(), ...(ok ? {} : { cause: text }) });
			continue;
		}
		// TAP: "ok 1 - name" / "not ok 2 - name"
		match = /^(not )?ok\b\s*(\d+)?\s*(?:[-–]\s*)?(.*)$/i.exec(text);
		if (match) {
			const ok = !match[1];
			out.push({ ok, name: (match[3] ?? "").trim() || `check ${match[2] ?? out.length + 1}`, ...(ok ? {} : { cause: text }) });
			continue;
		}
		// jest / vitest: "✓ name" / "✕ name"
		match = /^(✓|✔|√)\s+(.+)$/.exec(text);
		if (match) {
			out.push({ ok: true, name: match[2]!.trim() });
			continue;
		}
		match = /^(✕|✗|×|✘)\s+(.+)$/.exec(text);
		if (match) {
			out.push({ ok: false, name: match[2]!.trim(), cause: text });
			continue;
		}
	}
	return out;
}

/** The [ok]/[FAIL] lines of a set of parsed checks. */
export function checksToLines(checks: ParsedCheck[]): string[] {
	const lines: string[] = [];
	for (const check of checks) {
		lines.push(`[${check.ok ? "ok" : "FAIL"}] ${check.name}`);
		if (!check.ok && check.cause && check.cause !== check.name) lines.push(`        ${check.cause}`);
	}
	return lines;
}

/** The summary line every grader ends with ("3/10 checks passed"). */
export function summaryLine(passed: number, total: number): string {
	return `${passed}/${total} checks passed`;
}
