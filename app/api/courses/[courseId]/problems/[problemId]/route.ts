/**
 * /api/courses/[courseId]/problems/[problemId] (2026-11-09) — one problem.
 *
 *   GET  → the problem's files (the starter set, or whatever the learner
 *          has written since), its folder and the VS Code links
 *   PUT  → save one file (the in-app editor's write)
 *   POST → run it (the Run pane: make + the binary, python3, or sqlite3)
 *
 * The folder lives under the workspace root (~/cs50 by default, the
 * Settings knob) — the same folder VS Code opens, so the two modes are
 * one workspace, not two copies.
 */
import { getCourse, prepareProblem, readProblemFiles, runProblem, saveProblemFile, vscodeLinks } from "@/src/server";

export const dynamic = "force-dynamic";

/** The problem, or null (a missing course or problem). */
function find(courseId: string, problemId: string) {
	const course = getCourse(courseId);
	if (!course) return null;
	for (const unit of course.units) {
		for (const problem of unit.problems) {
			if (problem.id === problemId) return { course, unit, problem };
		}
	}
	return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ courseId: string; problemId: string }> }) {
	const { courseId, problemId } = await ctx.params;
	const found = find(courseId, problemId);
	if (!found) return Response.json({ error: `no problem "${problemId}" in "${courseId}"` }, { status: 404 });
	const prepared = await prepareProblem(found.course, found.problem);
	return Response.json({
		problem: found.problem,
		unit: { id: found.unit.id, title: found.unit.title },
		folder: prepared.folder,
		files: readProblemFiles(prepared.folder),
		vscode: vscodeLinks(prepared.folder),
	});
}

export async function PUT(req: Request, ctx: { params: Promise<{ courseId: string; problemId: string }> }) {
	const { courseId, problemId } = await ctx.params;
	const found = find(courseId, problemId);
	if (!found) return Response.json({ error: `no problem "${problemId}" in "${courseId}"` }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { name?: unknown; content?: unknown } | null;
	const name = typeof body?.name === "string" ? body.name : "";
	const content = typeof body?.content === "string" ? body.content : null;
	if (!name || content === null) return Response.json({ error: "name and content are required" }, { status: 400 });
	const prepared = await prepareProblem(found.course, found.problem);
	try {
		saveProblemFile(prepared.folder, name, content);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "The file could not be saved." }, { status: 400 });
	}
	return Response.json({ ok: true, name });
}

export async function POST(_req: Request, ctx: { params: Promise<{ courseId: string; problemId: string }> }) {
	const { courseId, problemId } = await ctx.params;
	const found = find(courseId, problemId);
	if (!found) return Response.json({ error: `no problem "${problemId}" in "${courseId}"` }, { status: 404 });
	await prepareProblem(found.course, found.problem);
	const result = await runProblem(found.course, found.problem);
	return Response.json(result);
}
