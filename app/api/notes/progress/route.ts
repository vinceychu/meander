/** GET /api/notes/progress — checklist progress across the vault, for /stats. */
import { notesProgress } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(notesProgress());
}
