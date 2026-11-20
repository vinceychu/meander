/**
 * FIND EVERYTHING (fork, 2026-10-26) — one query across the learner's whole
 * world: session titles + transcripts, knowledge-graph propositions, and
 * file NAMES under the usual personal folders (Desktop, Documents,
 * Downloads — override with LH_FIND_ROOTS, a path-delimiter-separated
 * list). File contents are deliberately not indexed here: picking a file
 * starts a session about it, and the agent's own read/grep tools take it
 * from there.
 *
 * Matching: every whitespace-separated token must appear (case-insensitive).
 * Read-only; the file-name index is cached for a minute.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stores } from "./stores.ts";

export interface FindResults {
	query: string;
	sessions: Array<{ id: string; title: string; kind: string; updatedAt: string; snippet: string }>;
	propositions: Array<{ id: string; name: string; statement: string }>;
	files: Array<{ path: string; name: string; dir: string }>;
	/** The folders whose file names were searched. */
	roots: string[];
}

const MAX_RESULTS = 12;

function tokensOf(q: string): string[] {
	return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(haystack: string, tokens: readonly string[]): boolean {
	const h = haystack.toLowerCase();
	return tokens.every((t) => h.includes(t));
}

/** A ~160-char window around the first token hit. */
function snippetAround(text: string, tokens: readonly string[]): string {
	const lower = text.toLowerCase();
	const at = Math.max(0, lower.indexOf(tokens[0] ?? ""));
	const start = Math.max(0, at - 60);
	const s = text.slice(start, start + 160).replace(/\s+/g, " ").trim();
	return (start > 0 ? "…" : "") + s + (start + 160 < text.length ? "…" : "");
}

/** Plain text of a session record's messages (user + assistant prose). */
function transcriptText(messages: readonly unknown[]): string {
	const out: string[] = [];
	for (const m of messages) {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") out.push(content);
		else if (Array.isArray(content)) {
			for (const b of content as Array<{ type?: string; text?: string }>) {
				if (b.type === "text" && typeof b.text === "string") out.push(b.text);
			}
		}
	}
	return out.join("\n");
}

// ─── File-name index ────────────────────────────────────────────────────────

export function findRoots(): string[] {
	const env = process.env.LH_FIND_ROOTS;
	const home = os.homedir();
	const roots = env ? env.split(path.delimiter).filter(Boolean) : ["Desktop", "Documents", "Downloads"].map((d) => path.join(home, d));
	return roots.filter((r) => {
		try {
			return fs.statSync(r).isDirectory();
		} catch {
			return false;
		}
	});
}

const SKIP_DIRS = new Set(["node_modules", ".git", "Library", ".Trash", "__pycache__", ".venv", "venv"]);
const MAX_INDEXED = 50_000;
const MAX_DEPTH = 8;
let fileIndex: { at: number; key: string; files: string[] } | null = null;

function buildFileIndex(roots: readonly string[]): string[] {
	const files: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (files.length >= MAX_INDEXED || depth > MAX_DEPTH) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) {
					files.push(full + path.sep);
					walk(full, depth + 1);
				}
			} else if (e.isFile()) files.push(full);
			if (files.length >= MAX_INDEXED) return;
		}
	};
	for (const r of roots) walk(r, 0);
	return files;
}

function indexedFiles(roots: readonly string[]): string[] {
	const key = roots.join("\0");
	if (!fileIndex || fileIndex.key !== key || Date.now() - fileIndex.at > 60_000) {
		fileIndex = { at: Date.now(), key, files: buildFileIndex(roots) };
	}
	return fileIndex.files;
}

// ─── The query ──────────────────────────────────────────────────────────────

export function findEverything(query: string): FindResults {
	const tokens = tokensOf(query);
	const roots = findRoots();
	if (tokens.length === 0) return { query, sessions: [], propositions: [], files: [], roots };

	const sessions: FindResults["sessions"] = [];
	for (const s of stores.chatStore.listChats()) {
		if (sessions.length >= MAX_RESULTS) break;
		if (matchesAll(s.title, tokens)) {
			sessions.push({ id: s.id, title: s.title, kind: s.kind, updatedAt: s.updatedAt, snippet: "" });
			continue;
		}
		const chat = stores.chatStore.getChat(s.id);
		if (!chat) continue;
		const text = transcriptText(chat.messages);
		if (matchesAll(text, tokens)) {
			sessions.push({ id: s.id, title: s.title, kind: s.kind, updatedAt: s.updatedAt, snippet: snippetAround(text, tokens) });
		}
	}

	const propositions: FindResults["propositions"] = [];
	for (const n of stores.graphStore.readNodes()) {
		if (propositions.length >= MAX_RESULTS) break;
		if (matchesAll(`${n.name}\n${n.statement}\n${n.aliases.join("\n")}`, tokens)) {
			propositions.push({ id: n.id, name: n.name, statement: n.statement });
		}
	}

	const files: FindResults["files"] = [];
	for (const f of indexedFiles(roots)) {
		if (files.length >= MAX_RESULTS) break;
		const trimmed = f.endsWith(path.sep) ? f.slice(0, -1) : f;
		const name = path.basename(trimmed) + (f.endsWith(path.sep) ? path.sep : "");
		if (matchesAll(name, tokens)) files.push({ path: trimmed, name, dir: path.dirname(trimmed) });
	}

	return { query, sessions, propositions, files, roots };
}
