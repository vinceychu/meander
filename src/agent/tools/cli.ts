import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { cliToolArgv, sandboxedCommand, type CliToolManifest } from "../../core/cli-tools.ts";
import { MAX_OUTPUT_BYTES } from "./fs-shared.ts";

/**
 * THE LEARNER'S CLI TOOLS (fork, 2026-10-26): one agent tool per attached
 * manifest (core/cli-tools.ts). execFile — never a shell — so the agent's
 * input is data, never extra commands. Output (exit code, stdout, stderr)
 * is capped at the fs tools' 50KB ceiling; the timeout kills the process.
 * Sandboxed by default (core/cli-tools.ts `sandboxedCommand`): a missing
 * sandbox launcher is reported, never bypassed.
 */

const cliInput = (description: string) =>
	Type.Object({ input: Type.String({ description }) });

/** Resolve "~", "./x" (against the tools dir) and plain names (PATH). */
function resolveAgainst(p: string, toolsDir: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	if (p.startsWith("./") || p.startsWith("../")) return path.resolve(toolsDir, p);
	return p;
}

function clip(s: string): string {
	const buf = Buffer.from(s, "utf-8");
	return buf.length <= MAX_OUTPUT_BYTES ? s : `${buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8")}\n[output truncated at 50KB]`;
}

const SANDBOX_HINT =
	process.platform === "linux"
		? "install bubblewrap (e.g. `sudo apt install bubblewrap`)"
		: "this system has no supported sandbox";

export function runCliTool(tool: CliToolManifest, toolsDir: string, input: string, platform: string = process.platform): Promise<string> {
	const command = resolveAgainst(tool.command, toolsDir);
	const cwd = tool.cwd ? (path.isAbsolute(tool.cwd) || tool.cwd.startsWith("~") ? resolveAgainst(tool.cwd, toolsDir) : path.resolve(toolsDir, tool.cwd)) : toolsDir;
	let launch = { command, args: cliToolArgv(tool, input) };
	if (tool.sandbox) {
		const plan = sandboxedCommand(platform, launch.command, launch.args, { writable: [path.resolve(toolsDir)], cwd });
		if ("unavailable" in plan) {
			return Promise.resolve(
				`not run: "${tool.name}" is sandboxed, but ${plan.unavailable}. ` +
					`To run it without a sandbox, the learner can set "sandbox": false in ${tool.file}.`,
			);
		}
		launch = plan;
	}
	return new Promise((resolve) => {
		const child = execFile(
			launch.command,
			launch.args,
			{ cwd, timeout: tool.timeoutSeconds * 1000, maxBuffer: 4 * MAX_OUTPUT_BYTES, windowsHide: true },
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
				const status = !err
					? "exit code 0"
					: err.killed
						? `killed after ${tool.timeoutSeconds}s timeout`
						: typeof err.code === "number"
							? `exit code ${err.code}`
							: tool.sandbox && err.code === "ENOENT" && launch.command !== command
								? `not run: the sandbox launcher (${launch.command}) is missing — ${SANDBOX_HINT}, or set "sandbox": false in ${tool.file}`
								: `failed to start: ${err.message}`;
				const parts = [status];
				if (stdout) parts.push(`stdout:\n${stdout}`);
				if (stderr) parts.push(`stderr:\n${stderr}`);
				resolve(clip(parts.join("\n\n")));
			},
		);
		if (tool.stdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		} else {
			child.stdin?.end();
		}
	});
}

/** One agent tool per manifest, keyed `cli_<name>`. */
export function cliTools(tools: readonly CliToolManifest[], toolsDir: string): Record<string, AgentTool<any>> {
	const out: Record<string, AgentTool<any>> = {};
	for (const tool of tools) {
		const name = `cli_${tool.name.replace(/-/g, "_")}`;
		const params = cliInput(tool.inputDescription);
		out[name] = {
			name,
			label: name,
			description:
				`The learner's own tool "${tool.name}": ${tool.description} ` +
				`Runs \`${tool.command}\` on the learner's machine and returns its exit status, stdout and stderr ` +
				`(timeout ${tool.timeoutSeconds}s)` +
				(tool.sandbox ? "; sandboxed: no network, and files are read-only except the tools folder and /tmp." : "."),
			parameters: params,
			execute: serverExecute(name, params, async ({ input }): Promise<string> => runCliTool(tool, toolsDir, input)),
		};
	}
	return out;
}
