/**
 * GET /api/notes — the vault index (2026-11-06): every file and folder,
 * each note's properties/tags/headings/links, backlink and tag maps.
 * Cached per file mtime server-side (src/server/notes.ts).
 *
 * The notes app polls this every 5s. With a large vault the index is
 * megabytes, so it carries a strong ETag: an unchanged index answers
 * 304 Not Modified and the browser reuses its cached copy (fetch revalidates
 * automatically). This keeps phones on cellular from re-downloading it.
 */
import { createHash } from "node:crypto";
import { notesIndex, notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	const body = JSON.stringify({ vault: notesVault.info(), index: notesIndex() });
	const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
	const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
	const match = request.headers.get("if-none-match");
	if (match && match.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}
