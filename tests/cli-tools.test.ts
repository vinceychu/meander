/**
 * USER CLI TOOL PINS (fork, 2026-10-26): manifest validation, argv
 * substitution, and a real round-trip through execFile (node itself is the
 * one executable every test host has).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cliToolArgv, parseCliToolManifest, sandboxedCommand } from "../src/core/cli-tools.ts";
import { execFileSync } from "node:child_process";
import { cliTools, runCliTool } from "../src/agent/tools/cli.ts";

describe("manifest parsing", () => {
	it("accepts a minimal manifest with defaults", () => {
		const r = parseCliToolManifest({ name: "py", description: "Python", command: "python3" }, "/x/py.json");
		assert.ok(r.ok);
		if (r.ok) {
			assert.deepEqual(r.tool.args, []);
			assert.equal(r.tool.stdin, false);
			assert.equal(r.tool.timeoutSeconds, 30);
			assert.equal(r.tool.default, false);
			assert.equal(r.tool.sandbox, true, "sandboxed unless the manifest opts out");
		}
	});
	it("reports every problem, never guesses", () => {
		const r = parseCliToolManifest({ name: "Bad Name", args: "x", timeoutSeconds: 9999 }, "f");
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.problems.length, 5);
	});
	it("opts out of the sandbox only with an explicit false", () => {
		const r = parseCliToolManifest({ name: "py", description: "d", command: "c", sandbox: false }, "f");
		assert.ok(r.ok && r.tool.sandbox === false);
		const bad = parseCliToolManifest({ name: "py", description: "d", command: "c", sandbox: "no" }, "f");
		assert.equal(bad.ok, false);
	});
	it("substitutes {{input}} into args without a shell", () => {
		assert.deepEqual(cliToolArgv({ args: ["-e", "{{input}}", "--x={{input}}"] }, "a; rm -rf /"), ["-e", "a; rm -rf /", "--x=a; rm -rf /"]);
	});
});

describe("running a tool", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-"));
	const base = { description: "d", inputDescription: "i", default: false, sandbox: false, file: "f" };

	it("pipes stdin and reports exit status + stdout", async () => {
		const out = await runCliTool(
			{ ...base, name: "echo", command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], stdin: true, timeoutSeconds: 10 },
			dir,
			"hello",
		);
		assert.match(out, /^exit code 0/);
		assert.match(out, /stdout:\nhello/);
	});
	it("reports a nonzero exit and stderr", async () => {
		const out = await runCliTool(
			{ ...base, name: "fail", command: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"], stdin: false, timeoutSeconds: 10 },
			dir,
			"",
		);
		assert.match(out, /^exit code 3/);
		assert.match(out, /stderr:\nboom/);
	});
	it("kills on timeout", async () => {
		const out = await runCliTool(
			{ ...base, name: "slow", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], stdin: false, timeoutSeconds: 1 },
			dir,
			"",
		);
		assert.match(out, /killed after 1s timeout/);
	});
	it("names agent tools cli_<name>", () => {
		const tools = cliTools([{ ...base, name: "my-tool", command: "x", args: [], stdin: false, timeoutSeconds: 5 }], dir);
		assert.deepEqual(Object.keys(tools), ["cli_my_tool"]);
	});
});

describe("the sandbox", () => {
	it("plans bubblewrap on Linux: read-only root, writable tools dir, no network", () => {
		const p = sandboxedCommand("linux", "python3", ["-"], { writable: ["/data/tools"], cwd: "/data/tools" });
		assert.ok("command" in p);
		if ("command" in p) {
			assert.equal(p.command, "bwrap");
			assert.deepEqual(p.args.slice(0, 3), ["--ro-bind", "/", "/"]);
			assert.ok(p.args.join(" ").includes("--bind /data/tools /data/tools"));
			assert.ok(p.args.includes("--unshare-all"), "unshares the network namespace");
			assert.deepEqual(p.args.slice(-3), ["--", "python3", "-"]);
		}
	});
	it("plans sandbox-exec on macOS with network and writes denied", () => {
		const p = sandboxedCommand("darwin", "python3", ["-"], { writable: ["/Users/me/tools"], cwd: "/Users/me/tools" });
		assert.ok("command" in p);
		if ("command" in p) {
			assert.equal(p.command, "/usr/bin/sandbox-exec");
			assert.match(p.args[1]!, /\(deny network\*\)/);
			assert.match(p.args[1]!, /\(subpath "\/Users\/me\/tools"\)/);
			assert.deepEqual(p.args.slice(2), ["python3", "-"]);
		}
	});
	it("fails closed where no sandbox exists", async () => {
		assert.ok("unavailable" in sandboxedCommand("win32", "x", [], { writable: [], cwd: "/" }));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-"));
		const out = await runCliTool(
			{ name: "t", description: "d", inputDescription: "i", default: false, sandbox: true, file: "t.json", command: process.execPath, args: ["-e", "console.log('ran')"], stdin: false, timeoutSeconds: 5 },
			dir,
			"",
			"win32",
		);
		assert.match(out, /^not run: .*sandboxed/);
		assert.doesNotMatch(out, /ran/);
	});

	let hasBwrap = false;
	try {
		execFileSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "true"], { stdio: "ignore" });
		hasBwrap = process.platform === "linux";
	} catch {}
	it("really confines a tool under bubblewrap", { skip: !hasBwrap && "bubblewrap not usable here" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cli-"));
		const outside = path.join(os.homedir(), `.lh-sandbox-probe-${process.pid}`);
		const script = [
			"const fs=require('fs');",
			`try{fs.writeFileSync(${JSON.stringify(outside)},'x');console.log('wrote-outside')}catch{console.log('outside-blocked')}`,
			`fs.writeFileSync(${JSON.stringify(path.join(dir, "ok.txt"))},'x');console.log('wrote-tools-dir');`,
			"require('net').connect(80,'1.1.1.1').on('connect',()=>{console.log('net-open');process.exit()}).on('error',()=>{console.log('net-blocked');process.exit()});",
		].join("");
		const out = await runCliTool(
			{ name: "probe", description: "d", inputDescription: "i", default: false, sandbox: true, file: "p.json", command: process.execPath, args: ["-e", script], stdin: false, timeoutSeconds: 10 },
			dir,
			"",
		);
		fs.rmSync(outside, { force: true });
		assert.match(out, /outside-blocked/);
		assert.match(out, /wrote-tools-dir/);
		assert.match(out, /net-blocked/);
	});
});
