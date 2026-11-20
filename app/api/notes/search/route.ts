/** GET /api/notes/search?q=… — full-text search with Obsidian operators. */
import { notesSearch } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
	const q = new URL(req.url).searchParams.get("q") ?? "";
	if (!q.trim()) return Response.json({ hits: [] });
	return Response.json({ hits: notesSearch(q.slice(0, 500)) });
}
