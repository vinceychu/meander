/**
 * NOTES SERVICE (2026-11-06): the vault index (cached per file mtime, so a
 * 5,000-note vault re-reads only what changed), search, backlinks with
 * context, unlinked mentions, rename with link updating, and attachment
 * cleanup on delete (Obsidian 1.12's "also delete attachments?" prompt).
 */
import * as store from "../store/notes.ts";
import {
	buildIndex,
	extractWikiLinks,
	extractMdLinks,
	isNotePath,
	LinkResolver,
	noteTitle,
	rewriteLinks,
	searchNotes,
	unlinkedMentions,
	type NoteMeta,
	type VaultFile,
	type VaultIndex,
} from "../core/notes.ts";
import { notesProgressFrom, type NotesProgress } from "../core/notes-progress.ts";

export { NotesPathError, NotesConflictError } from "../store/notes.ts";
export const notesVault = {
	info: store.vaultInfo,
	setRoot: store.setVaultRoot,
	readText: store.readText,
	readBinary: store.readBinary,
	stat: store.statNote,
	exists: store.exists,
	makeFolder: store.makeFolder,
	writeBinary: store.writeBinary,
};

const textCache = new Map<string, { mtime: number; size: number; text: string }>();
let indexCache: { key: string; index: VaultIndex } | null = null;

function cachedText(f: VaultFile): string | null {
	const hit = textCache.get(f.path);
	if (hit && hit.mtime === f.mtime && hit.size === f.size) return hit.text;
	const text = store.readText(f.path);
	if (text === null) return null;
	textCache.set(f.path, { mtime: f.mtime, size: f.size, text });
	return text;
}

export function notesIndex(): VaultIndex {
	const { files, folders } = store.listVault();
	const key = store.vaultInfo().root + "|" + files.map((f) => `${f.path}:${f.mtime}:${f.size}`).join("|") + "|" + folders.join("|");
	if (indexCache?.key === key) return indexCache.index;
	const live = new Set(files.map((f) => f.path));
	for (const k of textCache.keys()) if (!live.has(k)) textCache.delete(k);
	const byPath = new Map(files.map((f) => [f.path, f]));
	const index = buildIndex(files, (p) => cachedText(byPath.get(p)!));
	// Empty folders exist too.
	index.folders = [...new Set([...index.folders, ...folders])].sort();
	indexCache = { key, index };
	return index;
}

function noteTexts(index: VaultIndex): { meta: NoteMeta; text: string }[] {
	const files = new Map(index.files.map((f) => [f.path, f]));
	return index.notes.map((meta) => ({ meta, text: cachedText(files.get(meta.path)!) ?? "" }));
}

export function notesSearch(q: string, limit?: number) {
	return searchNotes(q, noteTexts(notesIndex()), limit);
}

/** Checklist progress across the vault (the /stats page's notes section). */
export function notesProgress(now: number = Date.now(), skipFolders: string[] = ["Templates"]): NotesProgress {
	const rows = noteTexts(notesIndex()).map(({ meta, text }) => ({ path: meta.path, title: meta.title, mtime: meta.mtime, text }));
	return notesProgressFrom(rows, now, { skipFolders });
}

/** Backlinks with the linking line for context, plus unlinked mentions. */
export function notesBacklinks(path: string) {
	const index = notesIndex();
	const resolver = new LinkResolver(index.files, index.notes);
	const texts = noteTexts(index);
	const linked = (index.backlinks[path] ?? []).map((from) => {
		const text = texts.find((t) => t.meta.path === from)?.text ?? "";
		const lines = text.split("\n");
		const hits: { line: number; snippet: string }[] = [];
		for (const l of [...extractWikiLinks(text), ...extractMdLinks(text)]) {
			if (resolver.resolve(l.target, from) !== path) continue;
			const line = text.slice(0, l.from).split("\n").length - 1;
			if (!hits.some((h) => h.line === line)) hits.push({ line, snippet: lines[line]!.trim().slice(0, 240) });
		}
		return { path: from, title: noteTitle(from), hits: hits.slice(0, 5) };
	});
	const meta = index.notes.find((n) => n.path === path);
	const mentions = meta
		? unlinkedMentions(meta.title, meta.aliases, texts.map((t) => ({ path: t.meta.path, text: t.text })), path).filter(
				(m) => !(index.backlinks[path] ?? []).includes(m.path),
			)
		: [];
	return { linked, mentions };
}

/** Rename/move a note, attachment or folder; rewrite every link to it. */
export function notesRename(from: string, to: string, updateLinks = true): { updated: string[] } {
	const before = notesIndex();
	const beforeResolver = new LinkResolver(before.files, before.notes);
	const isFolder = before.folders.includes(from) && !before.files.some((f) => f.path === from);
	const moves: [string, string][] = isFolder
		? before.files.filter((f) => f.path.startsWith(from + "/")).map((f) => [f.path, to + f.path.slice(from.length)])
		: [[from, to]];
	store.moveEntry(from, to);
	if (!updateLinks) return { updated: [] };
	const movedFiles = before.files.map((f) => {
		const m = moves.find(([a]) => a === f.path);
		return m ? { ...f, path: m[1] } : f;
	});
	const afterResolver = new LinkResolver(movedFiles, before.notes.map((n) => ({ path: moves.find(([a]) => a === n.path)?.[1] ?? n.path, aliases: n.aliases })));
	const updated: string[] = [];
	for (const n of before.notes) {
		if (!n.links.some((l) => l.path && moves.some(([a]) => a === l.path))) continue;
		const newPath = moves.find(([a]) => a === n.path)?.[1] ?? n.path;
		const text = store.readText(newPath);
		if (text === null) continue;
		let next = text;
		for (const [a, b] of moves) {
			if (!n.links.some((l) => l.path === a)) continue;
			// Links are written relative to where the note lived when they resolved.
			next = rewriteLinks(next, n.path, a, b, beforeResolver, afterResolver);
		}
		if (next !== text) {
			store.writeText(newPath, next);
			updated.push(newPath);
		}
	}
	indexCache = null;
	return { updated };
}

/** Attachments only this note embeds/links (candidates for deletion with it). */
export function notesOrphanAttachments(path: string): string[] {
	const index = notesIndex();
	const meta = index.notes.find((n) => n.path === path);
	if (!meta) return [];
	const mine = new Set(meta.links.map((l) => l.path).filter((p): p is string => !!p && !isNotePath(p) && !p.endsWith(".base")));
	for (const n of index.notes) {
		if (n.path === path) continue;
		for (const l of n.links) if (l.path) mine.delete(l.path);
	}
	return [...mine];
}

export function notesDelete(path: string, withAttachments = false): { trashed: string[] } {
	const trashed: string[] = [];
	const extra = withAttachments ? notesOrphanAttachments(path) : [];
	store.trashEntry(path);
	trashed.push(path);
	for (const a of extra) {
		store.trashEntry(a);
		trashed.push(a);
	}
	indexCache = null;
	return { trashed };
}

export function notesWrite(path: string, text: string, opts: { baseMtime?: number; create?: boolean } = {}): number {
	const m = store.writeText(path, text, opts);
	return m;
}
