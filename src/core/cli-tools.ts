/**
 * USER CLI TOOLS — the manifest contract (fork, 2026-10-26).
 *
 * A learner attaches their own programs to practice sessions: a Python
 * REPL to check numeric answers, a compiler, a SQL shell, a script of
 * their own ("a module" is just a script: `node my-module.mjs`). Each tool
 * is one JSON manifest in data/tools/, e.g. data/tools/python.json:
 *
 *   {
 *     "name": "python",
 *     "description": "Run a Python 3 program and return its output.",
 *     "command": "python3",
 *     "args": ["-"],
 *     "stdin": true,
 *     "inputDescription": "Python source code",
 *     "timeoutSeconds": 20,
 *     "default": true
 *   }
 *
 * The agent sees a tool named `cli_<name>` taking ONE string `input`.
 * The input reaches the program either on stdin (`"stdin": true`) or
 * substituted into any arg containing `{{input}}`. No shell is involved
 * (execFile semantics), so the input can never inject extra commands.
 *
 * SANDBOX (fork, 2026-10-27): by default the program runs sandboxed — the
 * whole filesystem read-only except the tools dir and a private /tmp, and
 * no network (bubblewrap on Linux, sandbox-exec on macOS). A manifest opts
 * out with `"sandbox": false` and then runs with the learner's full
 * permissions. Where no sandbox exists, a sandboxed tool refuses to run
 * (fail closed) rather than silently running unconfined.
 *
 * Pure: parsing, validation and argv planning. Spawning lives in the agent layer.
 */

export interface CliToolManifest {
	/** [a-z0-9_-]{1,40}; the agent's tool is `cli_<name>`. */
	name: string;
	/** What the tool does — the agent reads this to decide when to use it. */
	description: string;
	/** Executable: a name on PATH, an absolute path, or "./x" relative to the tools dir. */
	command: string;
	/** Fixed arguments; any "{{input}}" is replaced by the agent's input. */
	args: string[];
	/** Pipe the agent's input to stdin. */
	stdin: boolean;
	/** Shown to the agent as the input field's description. */
	inputDescription: string;
	/** Kill the process after this many seconds (1–600). */
	timeoutSeconds: number;
	/** Working directory ("~" = home; relative = against the tools dir). Default: the tools dir. */
	cwd?: string;
	/** Pre-selected when starting a practice session. */
	default: boolean;
	/** Run inside the sandbox (default true; `"sandbox": false` opts out). */
	sandbox: boolean;
	/** The manifest file it came from. */
	file: string;
}

export const CLI_TOOL_NAME_RE = /^[a-z0-9_-]{1,40}$/;

/** Parse one manifest; returns the manifest or a list of problems. */
export function parseCliToolManifest(raw: unknown, file: string): { ok: true; tool: CliToolManifest } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problems: ["manifest must be a JSON object"] };
	const o = raw as Record<string, unknown>;
	const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
	const name = str("name");
	if (!CLI_TOOL_NAME_RE.test(name)) problems.push(`"name" must match ${CLI_TOOL_NAME_RE} (lowercase letters, digits, _ or -)`);
	const description = str("description");
	if (!description) problems.push(`"description" is required`);
	const command = str("command");
	if (!command) problems.push(`"command" is required`);
	const args = o.args === undefined ? [] : o.args;
	if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) problems.push(`"args" must be an array of strings`);
	const timeout = o.timeoutSeconds === undefined ? 30 : o.timeoutSeconds;
	if (typeof timeout !== "number" || !(timeout >= 1 && timeout <= 600)) problems.push(`"timeoutSeconds" must be a number from 1 to 600`);
	if (o.cwd !== undefined && typeof o.cwd !== "string") problems.push(`"cwd" must be a string`);
	if (o.sandbox !== undefined && typeof o.sandbox !== "boolean") problems.push(`"sandbox" must be true or false`);
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		tool: {
			name,
			description,
			command,
			args: args as string[],
			stdin: o.stdin === true,
			inputDescription: str("inputDescription") || "The input passed to the program",
			timeoutSeconds: timeout as number,
			...(typeof o.cwd === "string" && o.cwd.trim() ? { cwd: o.cwd.trim() } : {}),
			default: o.default === true,
			sandbox: o.sandbox !== false,
			file,
		},
	};
}

/** The concrete argv for one call (pure — testable without spawning). */
export function cliToolArgv(tool: Pick<CliToolManifest, "args">, input: string): string[] {
	return tool.args.map((a) => a.split("{{input}}").join(input));
}

/** The client-safe listing row (GET /api/cli-tools). */
export interface CliToolInfo {
	name: string;
	description: string;
	default: boolean;
	sandbox: boolean;
}

// ─── The sandbox plan ───────────────────────────────────────────────────────

export type SandboxPlan = { command: string; args: string[] } | { unavailable: string };

/** The launcher that confines `command args`: read-only filesystem except
 *  `writable` dirs (+ a private tmp), no network. Pure — the platform is a
 *  parameter so both plans are testable on any host. */
export function sandboxedCommand(
	platform: string,
	command: string,
	args: readonly string[],
	opts: { writable: readonly string[]; cwd: string },
): SandboxPlan {
	if (platform === "linux") {
		return {
			command: "bwrap",
			args: [
				"--ro-bind", "/", "/",
				"--dev", "/dev",
				"--proc", "/proc",
				"--tmpfs", "/tmp",
				...opts.writable.flatMap((d) => ["--bind", d, d]),
				"--unshare-all",
				"--die-with-parent",
				"--new-session",
				"--chdir", opts.cwd,
				"--",
				command,
				...args,
			],
		};
	}
	if (platform === "darwin") {
		const sub = (d: string) => `(subpath ${JSON.stringify(d)})`;
		const profile = [
			"(version 1)",
			"(allow default)",
			"(deny network*)",
			"(deny file-write*)",
			`(allow file-write* ${[...opts.writable, "/private/tmp", "/private/var/folders"].map(sub).join(" ")} (literal "/dev/null") (literal "/dev/tty"))`,
		].join("\n");
		return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, command, ...args] };
	}
	return { unavailable: `no sandbox is available on ${platform}` };
}
