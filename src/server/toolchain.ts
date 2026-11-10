/**
 * THE TOOLCHAIN — the workspace, the compilers and the sandbox (2026-11-09).
 *
 * Three things every course needs, kept in one module because both the
 * course service (src/server/courses.ts) and the course adapters
 * (src/server/course-adapters/*) need them:
 *
 *   workspaceRoot()  where the problem folders live (~/cs50 by default)
 *   toolchainEnv()   the user's PATH plus the CS50 library paths
 *   runSandboxed()   the bubblewrap/sandbox-exec launcher — the learner's
 *                    code never runs with the server's full permissions
 *
 * A missing sandbox is reported, never bypassed.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sandboxedCommand } from "../core/cli-tools.ts";
import { effectiveSettings } from "./stores.ts";

/** The workspace root: where the problem folders live. */
export function workspaceRoot(): string {
	const configured = effectiveSettings().courses.workspaceRoot;
	const raw = configured?.trim() || "~/cs50";
	const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.resolve(expanded);
}

/** The toolchain environment (the env file the setup script writes). */
export function toolchainEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const file = path.join(os.homedir(), ".config", "meander", "cs50", "env");
	try {
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			const trimmed = line.trim().replace(/^export\s+/, "");
			if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
			const index = trimmed.indexOf("=");
			const key = trimmed.slice(0, index).trim();
			let value = trimmed.slice(index + 1).trim();
			if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
				value = value.slice(1, -1);
			}
			value = value.replace(/\$HOME/g, os.homedir()).replace(/\$\{HOME\}/g, os.homedir());
			if (key === "PATH") {
				// PATH entries are PREPENDED, never a replacement: the
				// learner's own PATH must survive the toolchain's.
				const existing = env.PATH ?? "";
				env.PATH = existing ? `${value}:${existing}` : value;
				continue;
			}
			env[key] = value;
		}
	} catch {
		/* no env file — the plain environment is used */
	}
	const shim = path.join(os.homedir(), ".local", "share", "meander", "cs50", "bin");
	env.PATH = `${shim}:${path.join(os.homedir(), ".local", "bin")}:${env.PATH ?? ""}`;
	return env;
}

/** The result of a run. */
export interface RunResult {
	ok: boolean;
	/** The combined output (stdout + stderr). */
	output: string;
	/** The command that ran. */
	command: string;
}

/**
 * The variables a course's own `.env` file may set.
 *
 * Courses ship these: CS61A's lab sets `PYTHONPATH=.grader` so the pytest
 * it vendors is importable. The grader runs with them, or the course's
 * own test suite cannot even start.
 *
 * The ALLOWLIST is the point: a course's `.env` is DATA the course
 * shipped, and data must not be able to change how the grader runs — no
 * PATH, no LD_PRELOAD, no LD_LIBRARY_PATH. Only the import paths a
 * vendored test suite needs are read. (The learner tool reads the same
 * list: learner-tools/course-tool.py.)
 */
export const COURSE_ENV_ALLOWLIST: readonly string[] = ["NODE_PATH", "PYTHONPATH"];

/** The variables a course's own `.env` file sets (the allowlisted ones). */
export function readEnvFile(folder: string): Record<string, string> {
	const out: Record<string, string> = {};
	let text: string;
	try {
		text = fs.readFileSync(path.join(folder, ".env"), "utf-8");
	} catch {
		return out;
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
		const index = trimmed.indexOf("=");
		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
		if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
			value = value.slice(1, -1);
		}
		if (COURSE_ENV_ALLOWLIST.includes(key)) out[key] = value;
	}
	return out;
}

/**
 * Run a command inside the CLI sandbox (bubblewrap on Linux, sandbox-exec
 * on macOS) — the learner's code never runs with the server's full
 * permissions. A missing sandbox is reported, never bypassed.
 *
 * `env` adds to the toolchain's environment (it never replaces it): a
 * course's own `.env` (the PYTHONPATH a vendored pytest needs) goes in
 * there.
 */
export function runSandboxed(
	command: string,
	args: string[],
	opts: {
		cwd: string;
		writable?: string[];
		timeoutMs?: number;
		input?: string;
		keepStdinOpen?: boolean;
		env?: Record<string, string | undefined>;
	},
): Promise<RunResult> {
	const writable = opts.writable ?? [opts.cwd];
	const plan = sandboxedCommand(process.platform, command, args, { writable, cwd: opts.cwd });
	if ("unavailable" in plan) {
		return Promise.resolve({
			ok: false,
			output: `not run: ${plan.unavailable}. The learner's code runs sandboxed — install bubblewrap on Linux, or run the problem in VS Code instead.`,
			command: `${command} ${args.join(" ")}`.trim(),
		});
	}
	return new Promise((resolve) => {
		const child = execFile(
			plan.command,
			plan.args,
			{
				cwd: opts.cwd,
				env: { ...toolchainEnv(), ...opts.env },
				timeout: opts.timeoutMs ?? 60_000,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const status = !err
					? "exit code 0"
					: err.killed
						? "killed after the timeout"
						: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
							? "the program printed more than the output buffer holds"
							: typeof err.code === "number"
								? `exit code ${err.code}`
								: `failed to start: ${err.message}`;
				const parts = [status];
				if (stdout) parts.push(stdout.trimEnd());
				if (stderr) parts.push(stderr.trimEnd());
				resolve({
					ok: !err,
					output: parts.join("\n"),
					command: `${command} ${args.join(" ")}`.trim(),
				});
			},
		);
		child.stdin?.on("error", () => {});
		if (opts.keepStdinOpen) {
			// The pipe stays OPEN: a program that asks for input gets the
			// sample, and a program that asks again waits (the timeout stops
			// it) instead of looping on the end of the file.
			if (opts.input !== undefined) child.stdin?.write(opts.input);
		} else if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		} else {
			child.stdin?.end();
		}
	});
}
