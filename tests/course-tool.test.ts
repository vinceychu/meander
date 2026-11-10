/**
 * THE COURSE LEARNER TOOL (2026-11-09): the script the app's Check button
 * and the agent's `cli_course` tool both run.
 *
 * The tool is the CS50 grader generalized: the same subcommands, but the
 * GRADER is the course's own — check50 for the CS50 family, the course's
 * own autograder or test suite for everything else, and an honest "no
 * autograder" when the course ships none.
 *
 * What is pinned here:
 * - the manifests: `course` is the tool, `cs50` is its alias, and both
 *   reach every session;
 * - the alias really is the same program (the old name still works);
 * - the catalogue holds more than one course, and `list` says how each
 *   problem is graded;
 * - `check` runs the course's own command and reads its output into the
 *   same [ok]/[FAIL] lines the tutor coaches from;
 * - the course's OWN code runs inside the SAME sandbox the app's Check
 *   button uses, and a course's `.env` may only set the import paths a
 *   vendored test suite needs — never LD_PRELOAD, never PATH.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCliToolManifest, sandboxedCommand } from "../src/core/cli-tools.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TOOL = path.join(REPO, "learner-tools", "course-tool.py");
const ALIAS = path.join(REPO, "learner-tools", "cs50-tool.py");
const MANIFEST = path.join(REPO, "learner-tools", "course.json");
const CS50_MANIFEST = path.join(REPO, "learner-tools", "cs50.json");

/**
 * A fake bubblewrap.
 *
 * Bubblewrap cannot create namespaces on every box (this one included), so
 * the test puts a `bwrap` on the PATH that RECORDS the confinement it was
 * asked for and then runs the command the way the real one would — same
 * working directory, same arguments. The RECORD is what the test asserts;
 * the command still runs for real.
 */
const FAKE_BWRAP = `#!/bin/sh
log="$LH_FAKE_SANDBOX_LOG"
if [ -n "$log" ]; then
	printf '%s\\n' "$@" >> "$log"
	printf '%s\\n' '---' >> "$log"
fi
chdir=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--chdir) chdir="$2"; shift 2;;
		--ro-bind|--bind) shift 3;;
		--dev|--proc|--tmpfs) shift 2;;
		--unshare-all|--die-with-parent|--new-session) shift;;
		--) shift; break;;
		*) break;;
	esac
done
if [ -n "$chdir" ]; then cd "$chdir" || exit 127; fi
exec "$@"
`;

const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-bin-"));
const SANDBOX_LOG = path.join(FAKE_BIN, "sandbox.log");
fs.writeFileSync(path.join(FAKE_BIN, "bwrap"), FAKE_BWRAP, { mode: 0o755 });

interface Run {
	code: number;
	out: string;
	err: string;
}

/** Run a tool with one subcommand line on stdin. */
function runTool(program: string, command: string, workspace: string, env: Record<string, string> = {}): Promise<Run> {
	return new Promise((resolve) => {
		const child = execFile(
			"python3",
			[program],
			{
				env: {
					...process.env,
					LH_WORKSPACE_ROOT: workspace,
					LH_FAKE_SANDBOX_LOG: SANDBOX_LOG,
					PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
					...env,
				},
				encoding: "utf-8",
				maxBuffer: 8 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				const err = error as { code?: number | string } | null;
				const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
				resolve({ code, out: stdout ?? "", err: stderr ?? "" });
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(command);
	});
}

/** The confinement the last sandboxed run was asked for. */
function lastSandboxRun(): string[] {
	try {
		const blocks = fs
			.readFileSync(SANDBOX_LOG, "utf-8")
			.split("---\n")
			.map((block) => block.split("\n").filter(Boolean))
			.filter((block) => block.length > 0);
		return blocks[blocks.length - 1] ?? [];
	} catch {
		return [];
	}
}


/**
 * A workspace with the catalogue the app writes: two courses, and the flat
 * list of the current course's problems (the shape older catalogues have).
 */
function workspaceFixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-"));
	const cs50Problem = {
		id: "mario-less",
		title: "Mario",
		slug: "cs50/problems/2026/x/mario/less",
		specUrl: "https://cs50.harvard.edu/x/psets/1/mario/less/",
		language: "c",
		file: "mario.c",
		folder: "mario-less",
		grader: "check50",
		readme: "# Mario\n\nPrint the pyramid.\n",
		files: { "mario.c": "#include <cs50.h>\n", Makefile: "CC = gcc\n" },
	};
	const testedProblem = {
		id: "lab01",
		title: "Lab 1: Widgets",
		slug: "",
		specUrl: "https://example.edu/course/labs/lab01.html",
		language: "python",
		folder: "lab01",
		grader: "tests",
		graderCommand: "python3 -c \"print('tests/test_widgets.py::test_makes_a_widget PASSED')\"",
		readme: "# Lab 1\n\nMake a widget.\n",
		files: { "widget.py": "def make_widget():\n    pass\n" },
	};
	const rubricProblem = {
		id: "essay",
		title: "Write about widgets",
		slug: "",
		specUrl: "https://example.edu/course/essay.html",
		language: "text",
		folder: "essay",
		grader: "ai-rubric",
		readme: "# Essay\n\nWrite about widgets.\n",
		files: { "README.md": "# Essay\n" },
	};
	// A course that hands its lab out in a subfolder ("lab02/lab01/") and
	// ships its own environment (the PYTHONPATH its vendored pytest needs —
	// and, because the course is DATA, an LD_PRELOAD and a PATH that must
	// never reach the grader).
	const nestedProblem = {
		id: "lab02",
		title: "Lab 2: Gizmos",
		slug: "",
		specUrl: "https://example.edu/course/labs/lab02.html",
		language: "python",
		folder: "lab02",
		grader: "tests",
		graderCommand:
			"python3 -c \"import os,json;open('ran-here.txt','w').write(json.dumps({'cwd':os.getcwd(),'PYTHONPATH':os.environ.get('PYTHONPATH',''),'LD_PRELOAD':os.environ.get('LD_PRELOAD',''),'PATH':os.environ.get('PATH','')}));print('tests/test_gizmos.py::test_gizmo PASSED')\"",
		graderWorkDir: "lab01",
		readme: "# Lab 2\n\nMake a gizmo.\n",
		files: {},
	};
	fs.mkdirSync(path.join(dir, "lab02", "lab01"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "lab02", "lab01", ".env"),
		"PYTHONPATH=.grader\nLD_PRELOAD=/tmp/lh-evil.so\nPATH=/tmp/lh-evil-bin\n",
		"utf-8",
	);
	fs.writeFileSync(
		path.join(dir, "catalogue.json"),
		JSON.stringify(
			{
				courseId: "widgets",
				courseTitle: "Introduction to Widgets",
				workspaceRoot: dir,
				// The flat list: the current course's problems (the old shape).
				problems: [testedProblem, rubricProblem, nestedProblem],
				// Every course on disk.
				courses: [
					{ courseId: "cs50x", courseTitle: "CS50x", problems: [cs50Problem] },
					{
						courseId: "widgets",
						courseTitle: "Introduction to Widgets",
						problems: [testedProblem, rubricProblem, nestedProblem],
					},
				],
			},
			null,
			"\t",
		),
		"utf-8",
	);
	return dir;
}

describe("the manifests", () => {
	it("ships the course tool as a default tool", () => {
		const raw = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
		const parsed = parseCliToolManifest(raw, MANIFEST);
		assert.ok(parsed.ok);
		if (!parsed.ok) return;
		assert.equal(parsed.tool.name, "course");
		assert.equal(parsed.tool.default, true, "every session gets the grader");
		assert.equal(parsed.tool.stdin, true);
		assert.equal(parsed.tool.command, "./course-tool.py");
	});

	it("keeps the cs50 tool as an alias", () => {
		const raw = JSON.parse(fs.readFileSync(CS50_MANIFEST, "utf-8"));
		const parsed = parseCliToolManifest(raw, CS50_MANIFEST);
		assert.ok(parsed.ok);
		if (!parsed.ok) return;
		assert.equal(parsed.tool.name, "cs50");
		assert.equal(parsed.tool.default, true);
		assert.equal(parsed.tool.command, "./cs50-tool.py");
	});

	it("ships the program the manifest names", () => {
		for (const file of [TOOL, ALIAS]) assert.ok(fs.existsSync(file), file);
	});
});

describe("the alias", () => {
	it("the old name runs the same program", async () => {
		const workspace = workspaceFixture();
		const viaCourse = await runTool(TOOL, "list", workspace);
		const viaCs50 = await runTool(ALIAS, "list", workspace);
		assert.equal(viaCourse.code, 0);
		assert.equal(viaCs50.code, 0);
		assert.equal(viaCs50.out, viaCourse.out);
	});

	it("accepts the leading 'course' the agent may type", async () => {
		const run = await runTool(TOOL, "course list", workspaceFixture());
		assert.match(run.out, /lab01/);
	});
});

describe("the course catalogue", () => {
	it("lists every course's problems and how each is graded", async () => {
		const run = await runTool(TOOL, "list", workspaceFixture());
		assert.match(run.out, /mario-less/);
		assert.match(run.out, /lab01/);
		assert.match(run.out, /graded by check50/);
		assert.match(run.out, /graded by tests/);
		assert.match(run.out, /graded by ai-rubric/);
	});

	it("says which problems are set up locally", async () => {
		const run = await runTool(TOOL, "list", workspaceFixture());
		assert.match(run.out, /not started/);
	});

	it("creates the problem's folder with its starter files", async () => {
		const workspace = workspaceFixture();
		const run = await runTool(TOOL, "start lab01", workspace);
		assert.equal(run.code, 0);
		assert.ok(fs.existsSync(path.join(workspace, "lab01", "widget.py")));
		assert.match(run.out, /ready:/);
	});

	it("never overwrites the learner's work", async () => {
		const workspace = workspaceFixture();
		await runTool(TOOL, "start lab01", workspace);
		const file = path.join(workspace, "lab01", "widget.py");
		fs.writeFileSync(file, "def make_widget():\n    return 'mine'\n", "utf-8");
		const run = await runTool(TOOL, "start lab01", workspace);
		assert.equal(fs.readFileSync(file, "utf-8"), "def make_widget():\n    return 'mine'\n");
		assert.match(run.out, /nothing overwritten/);
	});
});

describe("the grader the course ships", () => {
	it("runs the course's own command and reads its output", async () => {
		const workspace = workspaceFixture();
		await runTool(TOOL, "start lab01", workspace);
		const run = await runTool(TOOL, "check lab01", workspace);
		assert.match(run.out, /\[ok\] tests\/test_widgets\.py::test_makes_a_widget/);
		assert.match(run.out, /1\/1 checks passed/);
	});

	it("says so when the course ships no grader", async () => {
		const workspace = workspaceFixture();
		await runTool(TOOL, "start essay", workspace);
		const run = await runTool(TOOL, "check essay", workspace);
		assert.match(run.out, /no autograder/i);
		assert.match(run.out, /AI-reviewed, not an official autograder/);
	});

	it("runs the grader where the course's code lives, with the course's own env", async () => {
		const workspace = workspaceFixture();
		const run = await runTool(TOOL, "check lab02", workspace);
		assert.match(run.out, /\[ok\] tests\/test_gizmos\.py::test_gizmo/);
		// The command ran INSIDE the subfolder the course's lab lives in…
		const note = JSON.parse(
			fs.readFileSync(path.join(workspace, "lab02", "lab01", "ran-here.txt"), "utf-8"),
		) as { cwd: string; PYTHONPATH: string; LD_PRELOAD: string; PATH: string };
		assert.equal(note.cwd, path.join(workspace, "lab02", "lab01"));
		// …and with the course's own environment (its .env sets PYTHONPATH).
		assert.equal(note.PYTHONPATH, ".grader");
	});
});

// ─── the sandbox the course's own code runs in ──────────────────────────────

describe("the sandbox the course's own code runs in", () => {
	it("is the SAME plan the app's Check button uses", async () => {
		const workspace = workspaceFixture();
		await runTool(TOOL, "check lab02", workspace);
		const argv = lastSandboxRun();
		assert.ok(argv.length > 0, "the grader ran through the sandbox");
		// The confinement itself: the app's own plan (core/cli-tools.ts).
		const plan = sandboxedCommand("linux", "python3", ["-c", "print(1)"], {
			writable: [path.join(workspace, "lab02")],
			cwd: path.join(workspace, "lab02", "lab01"),
		});
		assert.ok(!("unavailable" in plan));
		const confinement = plan.args.slice(0, plan.args.indexOf("--"));
		assert.deepEqual(argv.slice(0, argv.indexOf("--")), confinement);
		// The course's own folder is the only writable place…
		const bind = argv.indexOf("--bind");
		assert.ok(bind >= 0);
		assert.equal(argv[bind + 1], path.join(workspace, "lab02"));
		assert.equal(argv[bind + 2], path.join(workspace, "lab02"));
		// …and there is no network and no namespace.
		assert.ok(argv.includes("--unshare-all"));
		assert.ok(argv.includes("--die-with-parent"));
		assert.ok(argv.includes("--new-session"));
	});

	it("builds the very same argv as the app's sandboxedCommand", async () => {
		// The tool is Python and the app is TypeScript, so the two plans are
		// compared by running the tool's own plan function.
		const script = [
			"import json, runpy, sys",
			"ns = runpy.run_path(sys.argv[1])",
			"print(json.dumps(ns['sandbox_plan'](sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), json.loads(sys.argv[5]), sys.argv[6])))",
		].join(";");
		const out = await new Promise<string>((resolve, reject) => {
			execFile(
				"python3",
				["-c", script, TOOL, "linux", "python3", JSON.stringify(["-c", "print(1)"]), JSON.stringify(["/tmp/work"]), "/tmp/work"],
				{ encoding: "utf-8" },
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		});
		const pythonPlan = JSON.parse(out.trim()) as string[];
		const plan = sandboxedCommand("linux", "python3", ["-c", "print(1)"], {
			writable: ["/tmp/work"],
			cwd: "/tmp/work",
		});
		assert.ok(!("unavailable" in plan));
		assert.equal(pythonPlan[0], plan.command);
		assert.deepEqual(pythonPlan.slice(1), plan.args);
	});

	it("never applies a course .env key outside the allowlist", async () => {
		const workspace = workspaceFixture();
		const run = await runTool(TOOL, "check lab02", workspace);
		assert.equal(run.code, 0, run.out);
		const note = JSON.parse(
			fs.readFileSync(path.join(workspace, "lab02", "lab01", "ran-here.txt"), "utf-8"),
		) as { PYTHONPATH: string; LD_PRELOAD: string; PATH: string };
		// The import path a vendored test suite needs: allowed.
		assert.equal(note.PYTHONPATH, ".grader");
		// The course's own LD_PRELOAD and PATH: DATA, not configuration.
		assert.equal(note.LD_PRELOAD, "");
		assert.ok(!note.PATH.includes("/tmp/lh-evil-bin"), "the course's PATH never reaches the grader");
	});

	it("says so when the sandbox launcher is missing — it never runs unsandboxed", async () => {
		// A PATH with python3 but no bubblewrap: the tool must refuse.
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lh-no-sandbox-"));
		fs.symlinkSync("/usr/bin/python3", path.join(bin, "python3"));
		const workspace = workspaceFixture();
		await runTool(TOOL, "start lab01", workspace);
		const run = await runTool(TOOL, "check lab01", workspace, { PATH: bin });
		assert.notEqual(run.code, 0);
		assert.match(run.out, /not run/);
		assert.match(run.out, /sandbox/);
	});
});

describe("the doctor", () => {
	it("reports the toolchain per language", async () => {
		const run = await runTool(TOOL, "doctor", workspaceFixture());
		assert.match(run.out, /check50:/);
		assert.match(run.out, /libcs50:/);
		assert.match(run.out, /gcc:/);
		assert.match(run.out, /python3:/);
		assert.match(run.out, /node:/);
		assert.match(run.out, /sqlite3:/);
		assert.match(run.out, /rustc:/);
		assert.match(run.out, /git:/);
	});
});
