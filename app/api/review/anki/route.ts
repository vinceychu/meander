/**
 * GET /api/review/anki — the knowledge graph as an Anki import file
 * (fork, 2026-10-27; format in core/anki.ts). Served as a download.
 */
import { ankiExport } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	const date = new Date().toISOString().slice(0, 10);
	return new Response(ankiExport(), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": `attachment; filename="meander-anki-${date}.txt"`,
		},
	});
}
