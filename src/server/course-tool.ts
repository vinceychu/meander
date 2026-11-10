/**
 * THE COURSE LEARNER TOOL — the grader the app and the agent share
 * (2026-11-09).
 *
 * The tool is one script (`learner-tools/course-tool.py`, aliased by
 * `cs50-tool.py`): it reads the workspace catalogue the app writes,
 * creates the problem's folder and shells out to the grader — check50 for
 * the CS50 family, the course's own test runner for everything else.
 *
 * It lives in its own module because both the course service (src/server/
 * courses.ts) and the CS50 adapter (src/server/course-adapters/cs50.ts)
 * need it, and a module that imports both would be a cycle.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { ensureDefaultCliTools } from "./cli-tools.ts";
import { toolchainEnv, workspaceRoot } from "./toolchain.ts";

/** The tool's script (the tools dir copy the app installs). */
export function courseToolScript(): string | null {
	// The shipped tools land in the tools dir on first use — the grader is
	// part of the app, not something the learner has to install by hand.
	ensureDefaultCliTools();
	for (const name of ["course-tool.py", "cs50-tool.py"]) {
		const file = path.join(PATHS.tools, name);
		try {
			if (fs.existsSync(file)) return file;
		} catch {
			/* try the next name */
		}
	}
	return null;
}

/**
 * Run one learner-tool subcommand ("check mario-less") through the tool.
 *
 * The tool is the single implementation of the grading path — the agent
 * calls it as `cli_course` (aliased `cli_cs50`) and the app's Check button
 * calls it here, so the two can never drift. The tool itself never
 * submits anything.
 */
export async function runCourseTool(command: string, opts: { workspaceRoot?: string } = {}): Promise<{ ok: boolean; output: string }> {
	const script = courseToolScript();
	if (!script) {
		return {
			ok: false,
			output:
				"The course grader is not installed yet — run the course tool's 'setup' subcommand (no sudo), " +
				"or install it from the app's learner-tools folder.",
		};
	}
	return new Promise((resolve) => {
		const child = execFile(
			"python3",
			[script],
			{
				cwd: path.dirname(script),
				env: {
					...toolchainEnv(),
					LH_WORKSPACE_ROOT: opts.workspaceRoot ?? workspaceRoot(),
				},
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

/** The old name (the CS50 grader) — the same tool. */
export const runCs50Tool = runCourseTool;
