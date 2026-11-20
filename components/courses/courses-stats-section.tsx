"use client";

/**
 * THE COURSES BLOCK IN STATS (2026-11-09) — where the learner stands in
 * each course: how far through, what is next, how much time is left.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpenIcon } from "lucide-react";
import { courseCompletion, courseRemainingMinutes, formatMinutes, nextStep, type Course, type CourseProgress } from "@/src/core";

interface Payload {
	course: Course;
	progress: CourseProgress;
}

export function CoursesStatsSection() {
	const [items, setItems] = useState<Payload[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch("/api/courses", { cache: "no-store" });
				if (!res.ok) throw new Error("courses");
				const list = (await res.json()) as { courses: Course[] };
				const loaded: Payload[] = [];
				for (const course of list.courses) {
					const detail = await fetch(`/api/courses/${course.id}`, { cache: "no-store" });
					if (!detail.ok) continue;
					loaded.push((await detail.json()) as Payload);
				}
				if (!cancelled) setItems(loaded);
			} catch {
				if (!cancelled) setItems([]);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (!items || items.length === 0) return null;

	return (
		<section data-testid="courses-progress" className="mt-8">
			<h2 className="text-base font-semibold text-foreground">Courses</h2>
			<ul className="mt-3 space-y-2">
				{items.map(({ course, progress }) => {
					const completion = courseCompletion(course, progress);
					const step = nextStep(course, progress);
					const pct = completion.total ? Math.round(completion.ratio * 100) : 0;
					return (
						<li key={course.id}>
							<Link href={`/courses/${course.id}`} className="block rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/50">
								<div className="flex items-baseline justify-between gap-2">
									<span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
										<BookOpenIcon className="size-3.5 text-muted-foreground" />
										{course.title}
									</span>
									<span className="shrink-0 tabular-nums text-xs text-muted-foreground">
										{completion.done}/{completion.total} · {pct}%
									</span>
								</div>
								<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
									<div className="h-full bg-primary/70" style={{ width: `${pct}%` }} />
								</div>
								<p className="mt-1.5 text-xs text-muted-foreground">
									{step
										? step.kind === "lesson"
											? `Next: the lesson — ${step.label}`
											: `Next: ${step.label}`
										: "Finished — every problem passed."}
									{" · "}
									{formatMinutes(courseRemainingMinutes(course, progress))} left
								</p>
							</Link>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
