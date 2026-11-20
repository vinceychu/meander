/** POST /api/notes/rename { from, to, updateLinks? } — move/rename and rewrite links. */
import { Notes } from "@/src/core";
import { NotesPathError, notesRename } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown; updateLinks?: unknown } | null;
	const from = Notes.cleanNotePath(b?.from);
	const to = Notes.cleanNotePath(b?.to);
	if (!from || !to) return Response.json({ error: "Invalid path" }, { status: 400 });
	if (from === to) return Response.json({ updated: [] });
	try {
		return Response.json(notesRename(from, to, b?.updateLinks !== false));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: err instanceof NotesPathError ? 400 : 500 });
	}
}
