/**
 * /api/courses (2026-11-09) — the course index.
 *
 *   GET  → the courses on disk + the catalogue the app ships with
 *   POST → fetch a course's syllabus and build its plan (the pages are
 *          cached, so the course works offline afterwards)
 *
 * Building is a server job (network + disk): the agent's course_plan tool
 * calls the same service, so a course built here and a course built by the
 * tutor are the same course.
 */
import { COURSE_CATALOG, allCourses, buildCourse, courseDefinition } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({
		courses: allCourses(),
		catalog: COURSE_CATALOG.map((c) => ({ id: c.id, title: c.title, source: c.source, edition: c.edition, blurb: c.blurb })),
	});
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { courseId?: unknown } | null;
	const courseId = typeof body?.courseId === "string" ? body.courseId.trim() : "";
	if (!courseId) return Response.json({ error: "courseId is required" }, { status: 400 });
	if (!courseDefinition(courseId)) {
		return Response.json({ error: `unknown course "${courseId}"`, supported: COURSE_CATALOG.map((c) => c.id) }, { status: 404 });
	}
	try {
		const course = await buildCourse(courseId);
		return Response.json({ course });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "The course could not be fetched." }, { status: 502 });
	}
}
