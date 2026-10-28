/**
 * GET /api/find?q=… — find everything (fork, 2026-10-26): sessions,
 * propositions, and file names under the personal folders
 * (src/server/find.ts). Backs the Find Everything palette (Mod+P in-app,
 * Ctrl/Cmd+Shift+Space system-wide in the desktop app).
 */

import { findEverything } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const q = new URL(req.url).searchParams.get("q") ?? "";
	return Response.json(findEverything(q.slice(0, 200)));
}
