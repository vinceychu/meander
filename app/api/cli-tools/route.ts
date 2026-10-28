/**
 * GET /api/cli-tools — the learner's CLI tool manifests (fork, 2026-10-26):
 * the folder they live in, the valid tools (name, description, default),
 * and per-file problems for manifests that failed to parse.
 */

import { cliToolsInfo } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(cliToolsInfo());
}
