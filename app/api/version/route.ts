/**
 * GET /api/version — the running Meander version (fork, 2026-11-13).
 * ~/bin/app-update-watch on the server compares it with the latest GitHub
 * release and restarts the service onto the new one.
 */
import pkg from "@/package.json";

export const dynamic = "force-static";

export function GET() {
	return Response.json({ name: "meander", version: pkg.version });
}
