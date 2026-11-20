"use client";

/**
 * THE COURSE (2026-11-09) — the plan, unit by unit.
 *
 * Each unit is a lesson (the tutor's condensed notes), a couple of video
 * slices worth watching, and the problems to do. The problems are done in
 * one of two places — the app's workspace or VS Code — and the same
 * buttons lead to both, so the choice is one click either way.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
	BookOpenIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	Code2Icon,
	ExternalLinkIcon,
	Loader2Icon,
	MessageSquareIcon,
	PlayCircleIcon,
	TimerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarToggle } from "@/components/sidebar";
import { MessageResponse } from "@/components/ai-elements/message";
import { CourseProgressBar, Estimate, NextMarker, ProblemStatusBadge, VariantChip } from "@/components/courses/course-parts";
import { StartCourseBlock } from "@/components/courses/courses-view";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";
import {
	formatMinutes,
	graderLabel,
	problemMode,
	progressKey,
	segmentUrl,
	type Course,
	type CourseProgress,
	type CourseUnit,
} from "@/src/core";

interface CoursePayload {
	course: Course;
	progress: CourseProgress;
	completion: { done: number; total: number; ratio: number };
	remaining: string;
	nextStep: { kind: "lesson" | "problem" | "done"; unitId: string; problemId?: string; label: string } | null;
}

export function CourseView({ courseId }: { courseId: string }) {
	const router = useRouter();
	const [data, setData] = useState<CoursePayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const starterRef = useMemo(() => new SessionStarter(), []);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/courses/${courseId}`, { cache: "no-store" });
			if (!res.ok) throw new Error("The course could not be loaded.");
			setData((await res.json()) as CoursePayload);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The course could not be loaded.");
		}
	}, [courseId]);

	useEffect(() => {
		void load();
	}, [load]);

	/** Ask the tutor about a unit (a session bound to the course). */
	const ask = useCallback(
		async (unit: CourseUnit, prompt: string) => {
			const target = await starterRef.start({ title: prompt, courseId }, fetch);
			router.push(target);
		},
		[courseId, router, starterRef],
	);

	if (error) {
		return (
			<div className="flex h-dvh flex-col">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					<SidebarToggle />
					<h1 className="font-ui text-sm font-medium">Courses</h1>
				</header>
				<main className="px-3 py-4">
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				</main>
			</div>
		);
	}

	if (!data) {
		return (
			<div className="flex h-dvh flex-col">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					<SidebarToggle />
					<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					<h1 className="font-ui text-sm font-medium">Loading the course…</h1>
				</header>
			</div>
		);
	}

	const { course, progress, completion, remaining } = data;
	const planned = course.units.some((u) => u.lesson.trim().length > 0);

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<SidebarToggle />
				<BookOpenIcon className="size-4 text-muted-foreground" />
				<h1 className="font-ui text-sm font-medium">{course.title}</h1>
				{course.edition && (
					<span className="rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
						{course.edition}
					</span>
				)}
				<div className="ml-auto flex items-center gap-3">
					<CourseProgressBar done={completion.done} total={completion.total} />
					<span className="hidden items-center gap-1 font-ui text-xs text-muted-foreground sm:flex">
						<TimerIcon className="size-3" />
						{remaining} left
					</span>
				</div>
			</header>

			<main className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
				{!planned && (
					<div className="mb-5 rounded-lg border border-dashed bg-card p-4">
						<p className="mb-2 text-sm text-muted-foreground">
							The syllabus is fetched, but the plan is not written yet. One prompt and the tutor drafts it: the lessons,
							the video slices worth watching, and which problems to do.
						</p>
						<StartCourseBlock courseId={course.id} title={course.title} />
					</div>
				)}

				<ol className="space-y-2">
					{course.units.map((unit) => {
						const expanded = open === unit.id;
						const isNext = data.nextStep?.unitId === unit.id;
						return (
							<li key={unit.id} className="rounded-lg border bg-card">
								<button
									type="button"
									onClick={() => setOpen(expanded ? null : unit.id)}
									aria-expanded={expanded}
									className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
								>
									{expanded ? <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
									{isNext && <NextMarker />}
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium">{unit.title}</span>
										{unit.summary && <span className="block truncate text-xs text-muted-foreground">{unit.summary}</span>}
									</span>
									<Estimate minutes={unit.estimateMinutes} />
								</button>

								{expanded && (
									<div className="border-t px-3 py-3">
										{/* The lesson — the tutor's condensed notes. */}
										{unit.lesson.trim() ? (
											<div className="lh-prose mb-4 max-w-none text-sm">
												<MessageResponse>{unit.lesson}</MessageResponse>
											</div>
										) : (
											<p className="mb-4 text-sm text-muted-foreground">
												No lesson yet — the tutor writes it when it plans the course.
											</p>
										)}

										{/* The video slices — only what is worth the minutes. */}
										{unit.videos.length > 0 && (
											<div className="mb-4">
												<h3 className="mb-1.5 font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Worth watching</h3>
												<ul className="space-y-1">
													{unit.videos.map((video) => (
														<li key={`${video.youtubeId}-${video.startSeconds ?? 0}`} className="flex items-start gap-2">
															<PlayCircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
															<span className="min-w-0">
																<a
																	href={segmentUrl(video)}
																	target="_blank"
																	rel="noreferrer"
																	className="text-sm underline-offset-2 hover:underline"
																>
																	{video.title}
																</a>
																{video.note && <span className="block text-xs text-muted-foreground">{video.note}</span>}
															</span>
														</li>
													))}
												</ul>
											</div>
										)}

										{/* The problems. */}
										{unit.problems.length > 0 && (
											<div className="mb-4">
												<h3 className="mb-1.5 font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Problems</h3>
												<ul className="space-y-2">
													{unit.problems.map((problem) => {
														const entry = progress[progressKey(unit.id, problem.id)];
														const mode = problemMode(course, problem);
														return (
															<li key={problem.id} className="rounded-md border bg-background px-2.5 py-2">
																<div className="flex flex-wrap items-center gap-2">
																	<span className="min-w-0 flex-1 truncate text-sm font-medium">{problem.title}</span>
																	<VariantChip variant={problem.variant} />
																	{/* How this problem is graded — the course's own grader, or the tutor's review. */}
																	<span className="rounded-sm border border-border px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
																		{graderLabel(problem)}
																	</span>
																	<ProblemStatusBadge status={entry?.status ?? "todo"} />
																	<Estimate minutes={problem.estimateMinutes} />
																</div>
																<div className="mt-2 flex flex-wrap items-center gap-1.5">
																	<Button
																		size="sm"
																		variant={mode === "app" ? "default" : "outline"}
																		onClick={() => router.push(`/courses/${course.id}/problem/${problem.id}`)}
																		data-testid={`start-problem-${problem.id}`}
																	>
																		<Code2Icon className="size-3.5" />
																		Start pset (app)
																	</Button>
																	<Button
																		size="sm"
																		variant="outline"
																		onClick={() => void ask(unit, `I'm working on ${problem.title} from ${course.title} — check it when I say so.`)}
																	>
																		<MessageSquareIcon className="size-3.5" />
																		Work with the tutor
																	</Button>
																</div>
															</li>
														);
													})}
												</ul>
											</div>
										)}

										<div className="flex flex-wrap items-center gap-2">
											<Button
												size="sm"
												variant="outline"
												onClick={() => void ask(unit, `Teach me ${unit.title} from ${course.title}.`)}
											>
												<BookOpenIcon className="size-3.5" />
												Start lesson
											</Button>
											{unit.notesUrl && (
												<a
													href={unit.notesUrl}
													target="_blank"
													rel="noreferrer"
													className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
												>
													<ExternalLinkIcon className="size-3.5" />
													The course's own notes
												</a>
											)}
											{unit.videos.length > 0 && (
												<span className="inline-flex items-center gap-1 font-ui text-xs text-muted-foreground">
													<CheckCircle2Icon className="size-3" />
													{unit.videos.length} video {unit.videos.length === 1 ? "slice" : "slices"}
												</span>
											)}
										</div>
									</div>
								)}
							</li>
						);
					})}
				</ol>
			</main>
		</div>
	);
}

/** The total time of a course (the summary line). */
export function courseTotal(course: Course): string {
	return formatMinutes(course.units.reduce((sum, u) => sum + u.estimateMinutes, 0));
}

/** A muted class helper (kept beside the view that uses it). */
export const courseMutedClass = cn("font-ui text-xs text-muted-foreground");
