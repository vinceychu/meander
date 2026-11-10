import { ProblemWorkspace } from "@/components/courses/problem-workspace";

export const dynamic = "force-dynamic";

/** One problem, done in the app: the editor, the Run pane and the grader. */
export default async function ProblemPage({ params }: { params: Promise<{ courseId: string; problemId: string }> }) {
	const { courseId, problemId } = await params;
	return <ProblemWorkspace courseId={courseId} problemId={problemId} />;
}
