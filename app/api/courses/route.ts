/**
 * /api/courses (2026-11-09) — the course index.
 *
 *   GET  → the courses on disk + the catalogue the app ships with
 *   POST → fetch a course's syllabus and build its plan (the pages are
 *          cached, so the course works offline afterwards)
 *
 * The POST takes a REFERENCE, not just an id: a catalogue id ("cs50x"), a
 * course URL ("https://cs61a.org/") or a course name ("MIT 6.0001"). The
 * name is resolved through the catalogue first and the web second; a URL
 * is read by the generic adapter (crawl the course's own pages, extract
 * the outline).
 *
 * Building is a server job (network + disk): the agent's course_plan tool
 * calls the same service, so a course built here and a course built by
 * the tutor are the same course.
 */
import { COURSE_CATALOG, allCourses, buildCourseFromRef } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({
		courses: allCourses(),
		catalog: COURSE_CATALOG.map((c) => ({ id: c.id, title: c.title, source: c.source, edition: c.edition, blurb: c.blurb })),
	});
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { courseId?: unknown; ref?: unknown } | null;
	const ref =
		typeof body?.ref === "string"
			? body.ref.trim()
			: typeof body?.courseId === "string"
				? body.courseId.trim()
				: "";
	if (!ref) return Response.json({ error: "a course id, URL or name is required" }, { status: 400 });
	try {
		const course = await buildCourseFromRef(ref);
		return Response.json({ course });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "The course could not be fetched." },
			{ status: 502 },
		);
	}
}
