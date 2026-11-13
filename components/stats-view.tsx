"use client";

import { useEffect, useState } from "react";
import { DownloadIcon, FlameIcon } from "lucide-react";
import type { NotesProgress, StudyStats } from "@/src/core";
import { SidebarToggle } from "@/components/sidebar";
import { CoursesStatsSection } from "@/components/courses/courses-stats-section";

/**
 * STUDY STATS PAGE (fork, 2026-10-27) — GET /api/stats rendered as tiles
 * and three small bar charts (study minutes per day, weekly retention, the
 * review forecast), plus the Anki export. Plain CSS bars: no chart library.
 */

function fmtMinutes(min: number): string {
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	return `${h}h ${String(min % 60).padStart(2, "0")}m`;
}

function shortDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
	return (
		<div className="rounded-lg border bg-card px-4 py-3">
			<div className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
			<div className="mt-1 text-2xl font-semibold text-card-foreground tabular-nums">{value}</div>
			{sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
		</div>
	);
}

function Bars({
	title,
	note,
	items,
	format,
	max,
}: {
	title: string;
	note: string;
	items: Array<{ key: string; label: string; value: number | null }>;
	format: (v: number) => string;
	max?: number;
}) {
	const top = max ?? Math.max(1, ...items.map((i) => i.value ?? 0));
	return (
		<section className="rounded-lg border bg-card px-4 py-3">
			<div className="flex items-baseline justify-between gap-2">
				<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">{title}</h2>
				<span className="text-[11px] text-muted-foreground">{note}</span>
			</div>
			<div className="mt-3 flex h-28 items-end gap-[3px]">
				{items.map((i) => (
					<div
						key={i.key}
						title={`${i.label}: ${i.value === null ? "no data" : format(i.value)}`}
						className="flex h-full min-w-0 flex-1 flex-col justify-end"
					>
						<div
							className={i.value === null ? "h-px bg-border" : "rounded-t-[2px] bg-primary/70 hover:bg-primary"}
							style={i.value === null ? undefined : { height: `${Math.max(2, (i.value / top) * 100)}%` }}
						/>
					</div>
				))}
			</div>
			<div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
				<span>{items[0]?.label}</span>
				<span>{items[items.length - 1]?.label}</span>
			</div>
		</section>
	);
}

function NotesProgressSection({ progress }: { progress: NotesProgress }) {
	const { totals } = progress;
	const pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
	return (
		<section data-testid="notes-progress" className="mt-8">
			<h2 className="text-base font-semibold text-foreground">Learning progress</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				From checklists in your notes. Write <code className="rounded bg-muted px-1">- [ ] Problem 0</code> lines in a note and check them off; checking stamps today&apos;s date.
			</p>
			{totals.total === 0 ? (
				<p className="mt-4 text-sm text-muted-foreground">No checklists yet.</p>
			) : (
				<>
					<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
						<Tile label="Tasks done" value={`${totals.done}/${totals.total}`} sub={`${pct}% overall`} />
						<Tile label="Done last 7 days" value={totals.doneLast7Days} sub={`${totals.notes} note${totals.notes === 1 ? "" : "s"} with checklists`} />
					</div>
					<div className="mt-3 grid gap-3 md:grid-cols-2">
						<Bars
							title="Tasks completed"
							note="last 30 days"
							items={progress.days.map((d) => ({ key: d.date, label: shortDate(d.date), value: d.done }))}
							format={(v) => `${v} done`}
						/>
						<section className="rounded-lg border bg-card px-4 py-3">
							<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">By note</h2>
							<ul className="mt-3 space-y-2">
								{progress.notes.slice(0, 12).map((n) => {
									const p = Math.round((n.done / n.total) * 100);
									return (
										<li key={n.path}>
											<a href={`/notes?open=${encodeURIComponent(n.path)}`} className="block rounded-sm hover:bg-accent/50" title={n.path}>
												<div className="flex items-baseline justify-between gap-2 text-xs">
													<span className="truncate text-card-foreground">{n.title}</span>
													<span className="shrink-0 tabular-nums text-muted-foreground">
														{n.done}/{n.total} · {p}%
													</span>
												</div>
												<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
													<div className={p === 100 ? "h-full bg-success/80" : "h-full bg-primary/70"} style={{ width: `${p}%` }} />
												</div>
											</a>
										</li>
									);
								})}
							</ul>
						</section>
					</div>
					<p className="mt-2 text-xs text-muted-foreground">A checked task without a ✅ date counts on its note&apos;s last-edit day.</p>
				</>
			)}
		</section>
	);
}

export function StatsView() {
	const [stats, setStats] = useState<StudyStats | null>(null);
	const [failed, setFailed] = useState(false);
	const [progress, setProgress] = useState<NotesProgress | null>(null);
	useEffect(() => {
		fetch("/api/notes/progress")
			.then((r) => (r.ok ? (r.json() as Promise<NotesProgress>) : null))
			.then(setProgress)
			.catch(() => setProgress(null));
	}, []);
	useEffect(() => {
		fetch("/api/stats")
			.then((r) => (r.ok ? (r.json() as Promise<StudyStats>) : Promise.reject(new Error(String(r.status)))))
			.then(setStats)
			.catch(() => setFailed(true));
	}, []);

	return (
		<div className="relative h-dvh overflow-y-auto">
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<main data-testid="stats-page" className="mx-auto max-w-4xl px-6 pb-12 pt-16">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<SidebarToggle />
						<h1 className="text-xl font-semibold text-foreground">Study stats</h1>
					</div>
					<a
						href="/api/review/anki"
						download
						data-testid="anki-export"
						title="Download every idea as an Anki deck (Anki: File → Import). Re-importing updates existing cards."
						className="lh-no-drag flex items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent"
					>
						<DownloadIcon aria-hidden="true" className="size-3" />
						Export to Anki
					</a>
				</div>

				{progress ? <NotesProgressSection progress={progress} /> : null}

				{/* COURSES (2026-11-09): where the learner stands in each course. */}
				<CoursesStatsSection />

				{failed ? <p className="mt-6 text-sm text-muted-foreground">Couldn&apos;t load stats.</p> : null}
				{!stats && !failed ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}

				{stats ? (
					<>
						<div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
							<Tile
								label="Streak"
								value={
									<span className="flex items-center gap-1.5">
										<FlameIcon className={`size-5 ${stats.studiedToday ? "text-orange-500" : "text-muted-foreground"}`} />
										{stats.streakDays} day{stats.streakDays === 1 ? "" : "s"}
									</span>
								}
								sub={stats.studiedToday ? `longest ${stats.longestStreak}` : stats.streakDays ? "study today to keep it" : `longest ${stats.longestStreak}`}
							/>
							<Tile label="Last 7 days" value={fmtMinutes(stats.minutesLast7Days)} sub={`${fmtMinutes(stats.minutesTotal)} all time`} />
							<Tile
								label="Retention"
								value={stats.reviews.retention === null ? "—" : `${Math.round(stats.reviews.retention * 100)}%`}
								sub={`${stats.reviews.total} practice review${stats.reviews.total === 1 ? "" : "s"}`}
							/>
							<Tile label="Ideas" value={stats.ideas} sub={`${stats.sessions.teach} lesson${stats.sessions.teach === 1 ? "" : "s"} · ${stats.sessions.practice} practice`} />
						</div>

						<div className="mt-4 grid gap-3 md:grid-cols-2">
							<Bars
								title="Study time"
								note="last 30 days"
								items={stats.days.map((d) => ({ key: d.date, label: shortDate(d.date), value: d.minutes }))}
								format={(v) => fmtMinutes(v)}
							/>
							<Bars
								title="Reviews due"
								note="next 14 days"
								items={stats.forecast.map((d, i) => ({ key: d.date, label: i === 0 ? "Today" : shortDate(d.date), value: d.due }))}
								format={(v) => `${v} due`}
							/>
							<Bars
								title="Retention"
								note="per week · share of reviews not forgotten"
								items={stats.weeks.map((w) => ({ key: w.start, label: shortDate(w.start), value: w.retention === null ? null : Math.round(w.retention * 100) }))}
								format={(v) => `${v}%`}
								max={100}
							/>
							<Bars
								title="Ideas learned"
								note="per week"
								items={stats.weeks.map((w) => ({ key: w.start, label: shortDate(w.start), value: w.ideasLearned }))}
								format={(v) => `${v} new`}
							/>
						</div>
						<p className="mt-4 text-xs text-muted-foreground">
							Study time counts the gaps between messages, at most 5 minutes each, so idle open sessions don&apos;t inflate it.
						</p>
					</>
				) : null}
			</main>
		</div>
	);
}
