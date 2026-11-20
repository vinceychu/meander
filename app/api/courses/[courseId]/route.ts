/**
 * /api/courses/[courseId] (2026-11-09) — one course.
 *
 *   GET    → the plan + the progress + the next step
 *   DELETE → forget the course (the plan, the progress, the cached pages)
 */
import { courseCompletion, courseRemainingMinutes, formatMinutes, nextStep } from "@/src/core";
import { getCourse, readProgress, removeCourse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ courseId: string }> }) {
	const { courseId } = await ctx.params;
	const course = getCourse(courseId);
	if (!course) return Response.json({ error: `no course "${courseId}"` }, { status: 404 });
	const progress = readProgress(courseId);
	const completion = courseCompletion(course, progress);
	const step = nextStep(course, progress);
	return Response.json({
		course,
		progress,
		completion,
		remaining: formatMinutes(courseRemainingMinutes(course, progress)),
		nextStep: step,
	});
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ courseId: string }> }) {
	const { courseId } = await ctx.params;
	removeCourse(courseId);
	return Response.json({ ok: true });
}
