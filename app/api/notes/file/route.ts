/**
 * /api/notes/file?path=… (2026-11-06)
 *   GET    → { content, mtime }
 *   PUT    { path, content, baseMtime? } → { mtime }   (409 = changed on disk)
 *   POST   { path, content? } → create (409 = exists)
 *   DELETE ?path=…&attachments=1 → move to the vault trash
 */
import { Notes } from "@/src/core";
import { NotesConflictError, NotesPathError, notesDelete, notesOrphanAttachments, notesVault, notesWrite } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_NOTE_BYTES = 8 * 1024 * 1024;

function fail(err: unknown) {
	if (err instanceof NotesConflictError) return Response.json({ error: err.message, code: "conflict", mtime: err.mtime }, { status: 409 });
	if (err instanceof NotesPathError) return Response.json({ error: err.message }, { status: 400 });
	return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
}

export function GET(req: Request) {
	const url = new URL(req.url);
	const path = Notes.cleanNotePath(url.searchParams.get("path"));
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	if (url.searchParams.get("orphans") === "1") return Response.json({ attachments: notesOrphanAttachments(path) });
	const content = notesVault.readText(path);
	if (content === null) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ path, content, mtime: notesVault.stat(path)?.mtime ?? 0 });
}

async function body(req: Request): Promise<{ path: string; content: string; baseMtime?: number } | Response> {
	const b = (await req.json().catch(() => null)) as { path?: unknown; content?: unknown; baseMtime?: unknown } | null;
	const path = Notes.cleanNotePath(b?.path);
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	const content = typeof b?.content === "string" ? b.content : "";
	if (content.length > MAX_NOTE_BYTES) return Response.json({ error: "Note too large" }, { status: 413 });
	return { path, content, baseMtime: typeof b?.baseMtime === "number" ? b.baseMtime : undefined };
}

export async function PUT(req: Request) {
	const b = await body(req);
	if (b instanceof Response) return b;
	try {
		return Response.json({ mtime: notesWrite(b.path, b.content, { baseMtime: b.baseMtime }) });
	} catch (err) {
		return fail(err);
	}
}

export async function POST(req: Request) {
	const b = await body(req);
	if (b instanceof Response) return b;
	try {
		return Response.json({ path: b.path, mtime: notesWrite(b.path, b.content, { create: true }) });
	} catch (err) {
		if (err instanceof NotesPathError && /exists/.test(err.message)) return Response.json({ error: err.message, code: "exists" }, { status: 409 });
		return fail(err);
	}
}

export function DELETE(req: Request) {
	const url = new URL(req.url);
	const path = Notes.cleanNotePath(url.searchParams.get("path"));
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	try {
		return Response.json(notesDelete(path, url.searchParams.get("attachments") === "1"));
	} catch (err) {
		return fail(err);
	}
}
