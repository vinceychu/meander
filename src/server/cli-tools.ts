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

/** The shipped tools that have already been copied into the data dir. */
const seededDirs = new Set<string>();

/**
 * THE SHIPPED LEARNER TOOLS (2026-11-09) — the app's own tools, copied
 * from the repo's learner-tools/ into the data dir's tools/ the first
 * time the tools are looked at.
 *
 * The cs50 grader ships with the app: its manifest (a default tool, so
 * every session can call it) and its script (the thing the manifest
 * runs). The copy is NEVER overwritten — a learner who edited the
 * script keeps their edit, and a learner who deleted the tool keeps it
 * deleted. Returns the file names that were copied.
 */
export function ensureDefaultCliTools(
	dir: string = PATHS.tools,
	source: string = PATHS.shippedTools,
): string[] {
	if (seededDirs.has(dir)) return [];
	seededDirs.add(dir);
	const copied: string[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(source);
	} catch {
		return copied; // a packaged build without the folder: nothing to ship
	}
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return copied;
	}
	for (const name of entries) {
		const from = path.join(source, name);
		const to = path.join(dir, name);
		try {
			const stat = fs.statSync(from);
			if (!stat.isFile()) continue;
			// Only the runnable parts ship (the README is documentation).
			if (!/\.(json|py|sh)$/i.test(name)) continue;
			// The learner's copy wins, always.
			if (fs.existsSync(to)) continue;
			fs.copyFileSync(from, to);
			fs.chmodSync(to, name.endsWith(".py") || name.endsWith(".sh") ? 0o755 : 0o644);
			copied.push(name);
		} catch {
			// A file that will not copy is skipped, not fatal.
		}
	}
	return copied;
}

export function loadCliTools(dir: string = PATHS.tools): CliToolsListing {
	if (dir === PATHS.tools) ensureDefaultCliTools();
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

/** Tools a teaching session gets without being asked: the "default": true ones. */
export function defaultCliAgentTools(): Record<string, AgentTool<any>> {
	return cliAgentTools(loadCliTools().tools.filter((t) => t.default).map((t) => t.name));
}
