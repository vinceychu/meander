/**
 * GET /api/notes — the vault index (2026-11-06): every file and folder,
 * each note's properties/tags/headings/links, backlink and tag maps.
 * Cached per file mtime server-side (src/server/notes.ts).
 */
import { notesIndex, notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ vault: notesVault.info(), index: notesIndex() });
}
