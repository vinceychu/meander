/** GET /api/notes/backlinks?path=… — linked mentions (with context) + unlinked mentions. */
import { Notes } from "@/src/core";
import { notesBacklinks } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
	const path = Notes.cleanNotePath(new URL(req.url).searchParams.get("path"));
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	return Response.json(notesBacklinks(path));
}
