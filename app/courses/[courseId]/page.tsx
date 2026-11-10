import { CourseView } from "@/components/courses/course-view";

export const dynamic = "force-dynamic";

/** One course: its units, their lessons, the videos worth watching and the
 *  problems to do. */
export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
	const { courseId } = await params;
	return <CourseView courseId={courseId} />;
}
