/** POST /api/notes/folder { path } — create a folder. */
import { Notes } from "@/src/core";
import { notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const b = (await req.json().catch(() => null)) as { path?: unknown } | null;
	const path = Notes.cleanNotePath(b?.path);
	if (!path) return Response.json({ error: "Invalid path" }, { status: 400 });
	try {
		notesVault.makeFolder(path);
		return Response.json({ path });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
	}
}
