/**
 * /api/graph/import-folder — learn a whole folder (fork, 2026-10-27).
 *   GET  ?path=…        preview: the note files that would be imported
 *   POST { path }       start one extraction run per note (background;
 *                       progress shows in the dock's status chips)
 */
import { folderNotes, importFolder } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
	const p = new URL(request.url).searchParams.get("path") ?? "";
	try {
		return Response.json(folderNotes(p));
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 400 });
	}
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { path?: unknown };
	if (typeof body.path !== "string" || !body.path) return Response.json({ ok: false, error: "path required" }, { status: 400 });
	const result = importFolder(body.path);
	return Response.json(result, { status: result.ok ? 202 : result.code === "models_not_configured" ? 409 : 400 });
}
