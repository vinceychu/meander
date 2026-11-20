"use client";
/**
 * MOBILE HOME (Meander, 2026-11-14) — the phone's Learn tab. Replaces the full-bleed graph / chain table on phones
 * (a graph of two dots and a desktop spreadsheet were useless at 393px). Cards, one thumb-reachable column:
 *   Continue (latest session) · Paper a Day · Review (due now) · Your course (next step + progress) · Recent sessions · New in your Brain.
 * PAPER A DAY (2026-11-16): one ML paper a day toward research at OpenAI (read → explain back → AI explains → build →
 *   self-test). It is the offline PWA at vincentychu.com/paper/ (own storage + offline pack), opened first-party.
 * The home composer stays docked at the bottom (home.tsx). Desktop never renders this.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpenIcon, BrainIcon, ChevronRightIcon, MessageSquareIcon, NewspaperIcon, RepeatIcon, SparklesIcon } from "lucide-react";
import { courseCompletion, nextStep, type Course, type CourseProgress } from "@/src/core";

export const PAPER_URL = "https://vincentychu.com/paper/";

type ChatRow = { id: string; title: string; updatedAt: string; kind: string; messageCount: number; pendingQuestion?: boolean };
type NoteRow = { path: string; title: string; mtime: number; folder: string };

function ago(iso: string | number) {
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	const s = Math.max(1, Math.round((Date.now() - t) / 1000));
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

function Card({ href, icon: Icon, label, title, sub, accent, testid }: {
	href: string; icon: typeof BookOpenIcon; label: string; title: string; sub?: string; accent?: boolean; testid: string;
}) {
	return (
		<Link href={href} data-testid={testid}
			className={"flex items-center gap-3 rounded-2xl border px-4 py-3.5 transition-colors active:scale-[0.99] " +
				(accent ? "border-foreground/20 bg-accent/60" : "border-border/60 bg-card/60")}>
			<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background/80">
				<Icon aria-hidden="true" className="size-5 text-foreground/80" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
				<span className="block truncate font-sans text-[15px] leading-snug text-foreground">{title}</span>
				{sub ? <span className="block truncate text-xs text-muted-foreground">{sub}</span> : null}
			</span>
			<ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
		</Link>
	);
}

export function MobileHome() {
	const [chats, setChats] = useState<ChatRow[] | null>(null);
	const [due, setDue] = useState<number>(0);
	const [course, setCourse] = useState<{ course: Course; progress: CourseProgress } | null>(null);
	const [notes, setNotes] = useState<NoteRow[]>([]);

	useEffect(() => {
		let live = true;
		const j = (u: string) => fetch(u, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
		void j("/api/chats").then((d) => live && setChats(((d?.chats ?? []) as ChatRow[]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))));
		void j("/api/review").then((d) => live && setDue((d?.due ?? []).length));
		void j("/api/courses").then(async (d) => {
			const c = d?.courses?.[0]; if (!c) return;
			const det = await j(`/api/courses/${c.id}`); if (live && det?.course) setCourse(det);
		});
		void j("/api/notes").then((d) => {
			const rows = ((d?.index?.notes ?? []) as NoteRow[]).filter((n) => n.path.startsWith("Brain/notes/"))
				.sort((a, b) => b.mtime - a.mtime).slice(0, 4);
			if (live) setNotes(rows);
		});
		return () => { live = false; };
	}, []);

	const last = chats?.[0];
	const step = course ? nextStep(course.course, course.progress) : null;
	const comp = course ? courseCompletion(course.course, course.progress) : null;

	return (
		<div data-testid="mobile-home" className="absolute inset-0 overflow-y-auto overscroll-contain px-4 pb-[16rem] pt-16">
			<h1 className="mb-1 font-serif text-[26px] leading-tight text-foreground">What are we learning?</h1>
			<p className="mb-4 text-sm text-muted-foreground">Pick up where you left off, or ask below.</p>
			<div className="flex flex-col gap-2.5">
				{last ? (
					<Card testid="mh-continue" href={`/chat/${last.id}`} icon={SparklesIcon} label={last.pendingQuestion ? "Continue · waiting for you" : "Continue"}
						title={last.title || "Untitled session"} sub={`${last.kind === "practice" ? "Practice" : "Teaching"} · ${ago(last.updatedAt)}`} accent />
				) : null}
				<Card testid="mh-paper" href={PAPER_URL} icon={NewspaperIcon} label="Paper a Day"
					title="Today's ML paper" sub="Read · explain back · build it · self-test" />
				<Card testid="mh-review" href="/stats" icon={RepeatIcon} label="Review"
					title={due > 0 ? `${due} card${due === 1 ? "" : "s"} due now` : "Nothing due"} sub={due > 0 ? "A few minutes keeps it fresh" : "You're all caught up"} />
				{course && comp ? (
					<Card testid="mh-course" href={`/courses/${course.course.id}`} icon={BookOpenIcon} label={`${course.course.title} · ${comp.done}/${comp.total}`}
						title={step ? (step.kind === "lesson" ? `Next: ${step.label}` : step.label) : "Course finished"} sub="Tap to keep going" />
				) : (
					<Card testid="mh-course" href="/courses" icon={BookOpenIcon} label="Courses" title="Learn a whole course" sub="CS50 and more, offline after the first fetch" />
				)}
			</div>

			{chats && chats.length > 1 ? (
				<section className="mt-6">
					<h2 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Recent sessions</h2>
					<div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card/40">
						{chats.slice(1, 6).map((c) => (
							<Link key={c.id} href={`/chat/${c.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-accent/50">
								<MessageSquareIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate font-sans text-[15px]">{c.title || "Untitled"}</span>
								<span className="shrink-0 text-xs text-muted-foreground">{ago(c.updatedAt)}</span>
							</Link>
						))}
					</div>
				</section>
			) : null}

			{notes.length ? (
				<section className="mt-6">
					<h2 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">New in your Brain</h2>
					<div className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 bg-card/40">
						{notes.map((n) => (
							<Link key={n.path} href={`/notes?open=${encodeURIComponent(n.path)}`} className="flex items-center gap-3 px-4 py-3 active:bg-accent/50">
								<BrainIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate font-sans text-[15px]">{n.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground">{ago(n.mtime)}</span>
							</Link>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}
