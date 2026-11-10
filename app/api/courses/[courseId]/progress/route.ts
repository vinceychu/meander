/**
 * /api/courses/[courseId]/progress (2026-11-09) — the learner's progress.
 *
 *   POST → merge one progress update (the status of a problem, the number
 *          of checks, a hint given, a solution shown)
 *
 * The update is a MERGE, not a replace: the store keeps the counts
 * absolute, so a client that reports "2 checks" cannot lose a count that
 * another client already recorded.
 */
import { updateProgress } from "@/src/server";
import type { ProblemStatus } from "@/src/core";

export const dynamic = "force-dynamic";

const STATUSES: ProblemStatus[] = ["todo", "in-progress", "passed", "submitted"];

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }) {
	const { courseId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as {
		unitId?: unknown;
		problemId?: unknown;
		status?: unknown;
		attempts?: unknown;
		hintsUsed?: unknown;
		solutionShown?: unknown;
	} | null;
	const unitId = typeof body?.unitId === "string" ? body.unitId : "";
	const problemId = typeof body?.problemId === "string" ? body.problemId : "";
	if (!unitId || !problemId) return Response.json({ error: "unitId and problemId are required" }, { status: 400 });
	const status = STATUSES.includes(body?.status as ProblemStatus) ? (body!.status as ProblemStatus) : undefined;
	const entry = updateProgress(courseId, {
		unitId,
		problemId,
		...(status ? { status } : {}),
		...(typeof body?.attempts === "number" ? { attempts: Math.max(0, Math.round(body.attempts)) } : {}),
		...(typeof body?.hintsUsed === "number" ? { hintsUsed: Math.max(0, Math.round(body.hintsUsed)) } : {}),
		...(body?.solutionShown === true ? { solutionShown: true } : {}),
		lastCheck: new Date().toISOString(),
	});
	return Response.json({ entry });
}
