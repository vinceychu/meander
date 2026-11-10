/**
 * THE cs50 LEARNER TOOL (2026-11-09): the script the app's Check button
 * and the agent's `cli_cs50` tool both run.
 *
 * What is pinned here is the ARGUMENT HANDLING and the file discipline —
 * the grader itself (check50) is the course's own, and its absence must
 * be reported honestly rather than faked:
 * - only the known subcommands run; anything else says what is allowed;
 * - a subcommand that needs a problem says so;
 * - `start` creates the problem's folder and NEVER overwrites the
 *   learner's work;
 * - `submit-info` prints the submit50 command and submits nothing.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseCliToolManifest } from "../src/core/cli-tools.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const TOOL = path.join(REPO, "learner-tools", "cs50-tool.py");
const MANIFEST = path.join(REPO, "learner-tools", "cs50.json");

interface Run {
	code: number;
	out: string;
	err: string;
}

/** Run the tool with one subcommand line on stdin. */
function runTool(command: string, workspace: string): Promise<Run> {
	return new Promise((resolve) => {
		const child = execFile(
			"python3",
			[TOOL],
			{
				env: { ...process.env, LH_WORKSPACE_ROOT: workspace },
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

/** A workspace with the catalogue the app writes. */
function workspaceFixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cs50-"));
	fs.writeFileSync(
		path.join(dir, "catalogue.json"),
		JSON.stringify(
			{
				courseId: "cs50x",
				courseTitle: "CS50x",
				workspaceRoot: dir,
				problems: [
					{
						id: "mario-less",
						title: "Mario",
						slug: "cs50/problems/2026/x/mario/less",
						specUrl: "https://cs50.harvard.edu/x/psets/1/mario/less/",
						language: "c",
						file: "mario.c",
						folder: "mario-less",
						readme: "# Mario\n\nPrint the pyramid.\n",
						files: { "mario.c": "#include <cs50.h>\n", "Makefile": "CC = gcc\n" },
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

describe("the manifest", () => {
	it("is a valid default tool", () => {
		const raw = JSON.parse(fs.readFileSync(MANIFEST, "utf-8"));
		const parsed = parseCliToolManifest(raw, MANIFEST);
		assert.ok(parsed.ok);
		if (!parsed.ok) return;
		assert.equal(parsed.tool.name, "cs50");
		assert.equal(parsed.tool.default, true, "every session gets the grader");
		assert.equal(parsed.tool.stdin, true);
		assert.equal(parsed.tool.command, "./cs50-tool.py");
	});
});

describe("the tool's argument handling", () => {
	it("refuses an unknown subcommand and says what is allowed", async () => {
		const run = await runTool("rm -rf /", workspaceFixture());
		assert.notEqual(run.code, 0);
		assert.match(run.err + run.out, /allowed:/);
	});

	it("says which subcommand needs a problem", async () => {
		const run = await runTool("check", workspaceFixture());
		assert.notEqual(run.code, 0);
		assert.match(run.err + run.out, /check needs a problem/);
	});

	it("reports an empty catalogue instead of pretending", async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cs50-empty-"));
		const run = await runTool("list", empty);
		assert.match(run.out, /no problems in the catalogue/);
	});

	it("lists the catalogue's problems", async () => {
		const run = await runTool("list", workspaceFixture());
		assert.match(run.out, /mario-less/);
		assert.match(run.out, /not started/);
	});

	it("names an unknown problem and the ones it knows", async () => {
		const run = await runTool("start nope", workspaceFixture());
		assert.notEqual(run.code, 0);
		assert.match(run.out, /unknown problem: nope/);
		assert.match(run.out, /known: mario-less/);
	});

	it("accepts the leading 'cs50' the agent may type", async () => {
		const run = await runTool("cs50 list", workspaceFixture());
		assert.match(run.out, /mario-less/);
	});
});

describe("the tool's file discipline", () => {
	it("creates the problem's folder with its starter files", async () => {
		const workspace = workspaceFixture();
		const run = await runTool("start mario-less", workspace);
		assert.equal(run.code, 0);
		const folder = path.join(workspace, "mario-less");
		assert.ok(fs.existsSync(path.join(folder, "mario.c")));
		assert.ok(fs.existsSync(path.join(folder, "Makefile")));
		assert.match(run.out, /ready:/);
	});

	it("never overwrites the learner's work", async () => {
		const workspace = workspaceFixture();
		await runTool("start mario-less", workspace);
		const file = path.join(workspace, "mario-less", "mario.c");
		fs.writeFileSync(file, "int main(void) { return 0; }\n", "utf-8");
		const run = await runTool("start mario-less", workspace);
		assert.equal(fs.readFileSync(file, "utf-8"), "int main(void) { return 0; }\n");
		assert.match(run.out, /nothing overwritten/);
	});

	it("prints the task", async () => {
		const workspace = workspaceFixture();
		const run = await runTool("task mario-less", workspace);
		assert.match(run.out, /Print the pyramid/);
	});

	it("prints the submit50 command and submits nothing", async () => {
		const workspace = workspaceFixture();
		const run = await runTool("submit-info mario-less", workspace);
		assert.match(run.out, /submit50 cs50\/problems\/2026\/x\/mario\/less/);
		assert.match(run.out, /never submits for you/);
	});

	it("reports the toolchain's state honestly", async () => {
		const run = await runTool("doctor", workspaceFixture());
		assert.match(run.out, /check50:/);
		assert.match(run.out, /libcs50:/);
	});
});
