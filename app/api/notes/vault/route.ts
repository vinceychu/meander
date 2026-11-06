/** GET/PUT /api/notes/vault — which folder is the vault ({ path: null } = default). */
import { NotesPathError, notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(notesVault.info());
}

export async function PUT(req: Request) {
	const b = (await req.json().catch(() => null)) as { path?: unknown } | null;
	const path = typeof b?.path === "string" ? b.path : null;
	try {
		notesVault.setRoot(path);
		return Response.json(notesVault.info());
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: err instanceof NotesPathError ? 400 : 500 });
	}
}
