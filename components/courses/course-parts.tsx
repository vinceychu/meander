"use client";

/**
 * COURSE PARTS (2026-11-09) — the small shared pieces of the course views:
 * the progress bar, the status badge, the problem row. Pure presentation —
 * the shapes come from @/src/core (the course model) so the shell and the
 * server agree on what a unit, a problem and a progress row are.
 */

import { CheckCircle2Icon, CircleDotIcon, CircleIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMinutes, type CourseProblem, type ProblemStatus } from "@/src/core";

/** The progress bar (the course's completion over its problems). */
export function CourseProgressBar({ done, total }: { done: number; total: number }) {
	const ratio = total > 0 ? done / total : 0;
	return (
		<div className="flex items-center gap-2">
			<div
				className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-valuenow={done}
				aria-valuemin={0}
				aria-valuemax={total}
			>
				<div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(ratio * 100)}%` }} />
			</div>
			<span className="font-ui text-xs text-muted-foreground">
				{done}/{total} problems
			</span>
		</div>
	);
}

/** The problem's status badge. */
export function ProblemStatusBadge({ status }: { status: ProblemStatus }) {
	if (status === "passed" || status === "submitted") {
		return (
			<span className="inline-flex items-center gap-1 font-ui text-[11px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
				<CheckCircle2Icon className="size-3" />
				{status === "submitted" ? "Submitted" : "Passed"}
			</span>
		);
	}
	if (status === "in-progress") {
		return (
			<span className="inline-flex items-center gap-1 font-ui text-[11px] uppercase tracking-wider text-warning">
				<Loader2Icon className="size-3" />
				In progress
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">
			<CircleIcon className="size-3" />
			To do
		</span>
	);
}

/** The variant chip ("less" / "more") — the learner's choice of problem. */
export function VariantChip({ variant }: { variant: CourseProblem["variant"] }) {
	if (variant === "standard") return null;
	return (
		<span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
			{variant}
		</span>
	);
}

/** The next-step marker on a unit row. */
export function NextMarker() {
	return <CircleDotIcon className="size-3.5 shrink-0 text-primary" aria-label="Next step" />;
}

/** The estimate line ("45m" / "1h 20m"). */
export function Estimate({ minutes }: { minutes: number }) {
	return <span className="font-ui text-xs text-muted-foreground">{formatMinutes(minutes)}</span>;
}
