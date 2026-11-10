"use client";

/**
 * THE COURSES INDEX (2026-11-09) — "Learn a course" in one click.
 *
 * The courses the app ships with (the catalogue) and the courses already on
 * disk (the learner's own). Starting a course opens a session whose FIRST
 * message is the one-prompt request ("I want to learn CS50x — draft me a
 * plan"), and the session is bound to the course at creation: the tutor
 * knows the course without being told again.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenIcon, GraduationCapIcon, Loader2Icon, PlayIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarToggle } from "@/components/sidebar";
import { CourseProgressBar } from "@/components/courses/course-parts";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";
import { courseCompletion, courseRemainingMinutes, formatMinutes, nextStep, type Course } from "@/src/core";

interface CatalogEntry {
	id: string;
	title: string;
	source: string;
	edition?: string;
	blurb: string;
}

interface CoursesPayload {
	courses: Course[];
	catalog: CatalogEntry[];
}

/** The opening message of a course session: the one-prompt request. */
export function courseOpeningPrompt(courseId: string, title: string): string {
	return `I want to learn ${title}. Fetch the syllabus and draft me a plan for it.`;
}

export function CoursesView() {
	const router = useRouter();
	const [data, setData] = useState<CoursesPayload | null>(null);
	const [starting, setStarting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const starterRef = useMemo(() => new SessionStarter(), []);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/courses", { cache: "no-store" });
			if (!res.ok) throw new Error("The course list could not be loaded.");
			setData((await res.json()) as CoursesPayload);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The course list could not be loaded.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/** Start a course: open a session bound to it, whose first message is
	 *  the one-prompt request. The tutor does the fetching (the syllabus
	 *  lands in the course's cache from there). */
	const start = useCallback(
		async (courseId: string, title: string) => {
			setStarting(courseId);
			setError(null);
			try {
				const target = await starterRef.start(
					{ title: courseOpeningPrompt(courseId, title), courseId },
					fetch,
				);
				router.push(target);
			} catch {
				setError("The session could not be opened. Try again.");
				setStarting(null);
			}
		},
		[router, starterRef],
	);

	const started = new Set((data?.courses ?? []).map((c) => c.id));
	const catalogue = data?.catalog ?? [];

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			<header className="flex items-center gap-2 border-b px-3 py-2">
				<SidebarToggle />
				<BookOpenIcon className="size-4 text-muted-foreground" />
				<h1 className="font-ui text-sm font-medium">Courses</h1>
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto"
					onClick={() => void load()}
					aria-label="Reload the course list"
				>
					Reload
				</Button>
			</header>

			<main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
				{error && (
					<p role="alert" className="mb-4 text-sm text-destructive">
						{error}
					</p>
				)}

				{/* ── The learner's own courses ── */}
				<section className="mb-8">
					<h2 className="mb-2 font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Your courses</h2>
					{!data ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : data.courses.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No courses yet. Start one below — the syllabus is fetched once and kept on disk, so it works offline afterwards.
						</p>
					) : (
						<ul className="grid gap-2 sm:grid-cols-2">
							{data.courses.map((course) => {
								const completion = courseCompletion(course, {});
								return (
									<li key={course.id}>
										<button
											type="button"
											onClick={() => router.push(`/courses/${course.id}`)}
											className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
										>
											<span className="flex items-center gap-2">
												<GraduationCapIcon className="size-4 text-muted-foreground" />
												<span className="font-medium">{course.title}</span>
												{course.edition && (
													<span className="rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
														{course.edition}
													</span>
												)}
											</span>
											<span className="mt-2 block">
												<CourseProgressBar done={completion.done} total={completion.total} />
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</section>

				{/* ── The catalogue ── */}
				<section>
					<h2 className="mb-2 font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Available courses</h2>
					<ul className="grid gap-2 sm:grid-cols-2">
						{catalogue.map((entry) => (
							<li key={entry.id} className="rounded-lg border bg-card p-3">
								<span className="flex items-center gap-2">
									<SparklesIcon className="size-4 text-muted-foreground" />
									<span className="font-medium">{entry.title}</span>
									{entry.edition && (
										<span className="rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
											{entry.edition}
										</span>
									)}
								</span>
								<p className="mt-1.5 text-sm text-muted-foreground">{entry.blurb}</p>
								<div className="mt-2.5 flex items-center gap-2">
									<Button
										size="sm"
										onClick={() => void start(entry.id, entry.title)}
										disabled={starting !== null}
										data-testid={`start-course-${entry.id}`}
									>
										{starting === entry.id ? (
											<>
												<Loader2Icon className="size-3.5 animate-spin" />
												Starting…
											</>
										) : (
											<>
												<PlayIcon className="size-3.5" />
												{started.has(entry.id) ? "Continue" : "Learn this course"}
											</>
										)}
									</Button>
									{started.has(entry.id) && (
										<Button variant="ghost" size="sm" onClick={() => router.push(`/courses/${entry.id}`)}>
											Open
										</Button>
									)}
								</div>
							</li>
						))}
					</ul>
				</section>
			</main>
		</div>
	);
}

/** The "start this course" block on the course page (shared with the
 *  detail view when the plan has not been written yet). */
export function StartCourseBlock({ courseId, title }: { courseId: string; title: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const starterRef = useMemo(() => new SessionStarter(), []);
	return (
		<Button
			size="sm"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const target = await starterRef.start({ title: courseOpeningPrompt(courseId, title), courseId }, fetch);
					router.push(target);
				} catch {
					setBusy(false);
				}
			}}
		>
			{busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
			Plan this course with the tutor
		</Button>
	);
}

/** The next-step line of a course (the sidebar's line too). */
export function courseNextStep(course: Course, progress: Parameters<typeof nextStep>[1]): string {
	const step = nextStep(course, progress);
	if (!step) return "Done — the whole course is finished.";
	if (step.kind === "lesson") return `Next: the lesson — ${step.label}`;
	return `Next: ${step.label}`;
}

/** The remaining time of a course. */
export function courseRemaining(course: Course, progress: Parameters<typeof courseRemainingMinutes>[1]): string {
	return formatMinutes(courseRemainingMinutes(course, progress));
}

/** A muted label (the shared class for the course views' secondary text). */
export function Muted({ children, className }: { children: React.ReactNode; className?: string }) {
	return <span className={cn("font-ui text-xs text-muted-foreground", className)}>{children}</span>;
}
