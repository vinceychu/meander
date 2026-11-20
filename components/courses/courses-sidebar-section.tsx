"use client";

/**
 * THE COURSES SECTION (2026-11-09) — the sidebar's course block.
 *
 * The active course, its next step and its progress. The block is quiet
 * when there is no course: an empty line, never a dead control.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { courseCompletion, nextStep, type Course, type CourseProgress } from "@/src/core";

interface Payload {
	course: Course;
	progress: CourseProgress;
	completion: { done: number; total: number; ratio: number };
}

export function CoursesSidebarSection() {
	const router = useRouter();
	const [data, setData] = useState<Payload | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/courses", { cache: "no-store" });
			if (!res.ok) throw new Error("courses");
			const payload = (await res.json()) as { courses: Course[] };
			const course = payload.courses[0];
			if (!course) {
				setData(null);
				return;
			}
			const detailRes = await fetch(`/api/courses/${course.id}`, { cache: "no-store" });
			if (!detailRes.ok) throw new Error("course");
			setData((await detailRes.json()) as Payload);
		} catch {
			setData(null);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (!data) {
		return (
			<button
				type="button"
				data-testid="sidebar-courses-entry"
				onClick={() => router.push("/courses")}
				className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<BookOpenIcon className="size-3" />
				Courses
			</button>
		);
	}

	const step = nextStep(data.course, data.progress);
	const completion = courseCompletion(data.course, data.progress);

	return (
		<button
			type="button"
			data-testid="sidebar-courses-entry"
			onClick={() => router.push(`/courses/${data.course.id}`)}
			className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
		>
			<BookOpenIcon className="size-3 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-xs uppercase tracking-wider text-muted-foreground">{data.course.title}</span>
				<span className="block truncate font-ui text-[11px] text-muted-foreground/80">
					{step ? (step.kind === "lesson" ? `Lesson: ${step.label}` : step.label) : "Finished"}
				</span>
			</span>
			<span className="shrink-0 font-ui text-[10px] text-muted-foreground/80">
				{completion.done}/{completion.total}
			</span>
			<ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground/60")} />
		</button>
	);
}
