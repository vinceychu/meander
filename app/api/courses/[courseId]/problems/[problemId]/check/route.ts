/**
 * /api/courses/[courseId]/problems/[problemId]/check (2026-11-09) — grade it.
 *
 * The Check button and the agent's `cli_cs50` tool run the SAME grader
 * (the cs50 learner tool), so the two can never disagree about what
 * passed. The grader never submits anything to CS50 — that stays the
 * learner's own act.
 *
 * The verdict is recorded: the attempt is counted, a run whose checks all
 * passed marks the problem "passed" and a run with failures marks it
 * "in-progress" (the progress the sidebar and Stats read). A run that
 * produced no verdict at all (the grader is missing, the program does not
 * compile) leaves the status alone.
 */
import { getCourse, parseCheckOutput, prepareProblem, readProgress, runCs50Tool, updateProgress } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ courseId: string; problemId: string }> }) {
	const { courseId, problemId } = await ctx.params;
	const course = getCourse(courseId);
	if (!course) return Response.json({ error: `no course "${courseId}"` }, { status: 404 });
	const found = course.units.flatMap((unit) =>
		unit.problems.map((problem) => ({ unit, problem })),
	).find((entry) => entry.problem.id === problemId);
	if (!found) return Response.json({ error: `no problem "${problemId}" in "${courseId}"` }, { status: 404 });
	prepareProblem(course, found.problem);
	const result = await runCs50Tool(`check ${problemId}`);
	const verdict = parseCheckOutput(result.output);
	// The attempt count is ABSOLUTE in the store: read the row first, so
	// this check counts as one more and never as "one".
	const current = readProgress(courseId)[`${found.unit.id}/${problemId}`];
	// A run whose checks all passed marks the problem "passed"; a run with
	// failures means the learner is ON it ("in-progress"). A problem that
	// was already passed or submitted is never downgraded by a later run.
	const done = current?.status === "passed" || current?.status === "submitted";
	const status = verdict.total > 0 && verdict.failed.length === 0 ? "passed" : done ? current?.status : "in-progress";
	const progress = updateProgress(courseId, {
		unitId: found.unit.id,
		problemId,
		attempts: (current?.attempts ?? 0) + 1,
		...(status !== undefined ? { status } : {}),
	});
	return Response.json({ ...result, problemId, verdict, progress });
}
