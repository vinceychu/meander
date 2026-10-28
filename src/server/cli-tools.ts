/**
 * The learner's CLI tools — loading + composition (fork, 2026-10-26).
 * Manifests are read fresh on every call (a handful of small files), so a
 * tool dropped into data/tools/ is usable in the next session without a
 * restart. Malformed manifests are reported, never guessed at.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../config.ts";
import { parseCliToolManifest, type CliToolInfo, type CliToolManifest } from "../core/cli-tools.ts";
import { cliTools } from "../agent/tools/cli.ts";

export interface CliToolsListing {
	dir: string;
	tools: CliToolManifest[];
	/** file → problems, for manifests that failed to parse. */
	errors: Record<string, string[]>;
}

export function loadCliTools(dir: string = PATHS.tools): CliToolsListing {
	const tools: CliToolManifest[] = [];
	const errors: Record<string, string[]> = {};
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return { dir, tools, errors };
	}
	const seen = new Set<string>();
	for (const f of files) {
		const file = path.join(dir, f);
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		} catch (e) {
			errors[f] = [`not valid JSON: ${(e as Error).message}`];
			continue;
		}
		const parsed = parseCliToolManifest(raw, file);
		if (!parsed.ok) {
			errors[f] = parsed.problems;
			continue;
		}
		if (seen.has(parsed.tool.name)) {
			errors[f] = [`duplicate tool name "${parsed.tool.name}"`];
			continue;
		}
		seen.add(parsed.tool.name);
		tools.push(parsed.tool);
	}
	return { dir, tools, errors };
}

/** The client-safe listing (no commands or paths beyond the folder). */
export function cliToolsInfo(): { dir: string; tools: CliToolInfo[]; errors: Record<string, string[]> } {
	const { dir, tools, errors } = loadCliTools();
	return { dir, tools: tools.map((t) => ({ name: t.name, description: t.description, default: t.default, sandbox: t.sandbox })), errors };
}

/** The agent tools for a session's attached names (unknown names skipped —
 *  a manifest deleted since creation simply drops out). */
export function cliAgentTools(names: readonly string[] | undefined): Record<string, AgentTool<any>> {
	if (!names || names.length === 0) return {};
	const { dir, tools } = loadCliTools();
	const wanted = new Set(names);
	return cliTools(tools.filter((t) => wanted.has(t.name)), dir);
}
