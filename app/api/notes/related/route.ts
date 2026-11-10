/** GET /api/notes/related?path=… — similar notes. ?edges=1 — dashed graph pairs. */
import { Notes } from "@/src/core";
import { notesRelated, notesRelatedEdges } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
	const url = new URL(req.url);
	if (url.searchParams.get("edges") === "1") {
		return Response.json({ edges: notesRelatedEdges(), threshold: Notes.RELATED_EDGE_THRESHOLD });
	}
	const path = Notes.cleanNotePath(url.searchParams.get("path"));
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	return Response.json({ related: notesRelated(path) });
}
