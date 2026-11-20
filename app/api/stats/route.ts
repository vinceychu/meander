/**
 * GET /api/stats — the study-stats page's numbers (fork, 2026-10-27):
 * streak, study time, retention, review forecast. Derived on every read.
 */
import { studyStats } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(studyStats());
}
