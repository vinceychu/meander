/**
 * STUDY STATS (fork, 2026-10-27) — streak, study time, retention, and the
 * review forecast, for the /stats page.
 *
 * Derived, never stored (the same law as review.ts): everything here is a
 * fold over the session records' message timestamps, the practice review
 * events (review.ts), and the graph's node creation times.
 *
 *   - A STUDY DAY is a local calendar day with at least one learner message.
 *   - STUDY TIME sums the gaps between consecutive messages of a session,
 *     each gap capped at IDLE_CAP_MS — a session left open overnight counts
 *     five minutes, not eight hours.
 *   - RETENTION is the share of practice reviews that were not a lapse
 *     ("again"): Anki's "true retention".
 *
 * Pure + browser-safe. Days are the host's local calendar days.
 */

import { allReviewEvents, reviewStates, type ReviewDeps } from "./review.ts";

/** One gap between messages counts at most this much study time. */
export const IDLE_CAP_MS = 5 * 60_000;

export interface StudyStats {
	now: number;
	/** Consecutive study days ending today (or yesterday, if today has none yet). */
	streakDays: number;
	studiedToday: boolean;
	longestStreak: number;
	minutesLast7Days: number;
	minutesTotal: number;
	sessions: { teach: number; practice: number };
	ideas: number;
	reviews: { total: number; retention: number | null };
	/** The last 30 days, oldest first. */
	days: Array<{ date: string; minutes: number; reviews: number }>;
	/** The last 12 weeks (7-day blocks ending today), oldest first. */
	weeks: Array<{ start: string; reviews: number; retention: number | null; ideasLearned: number }>;
	/** Reviews coming due over the next 14 days; day 0 includes everything overdue. */
	forecast: Array<{ date: string; due: number }>;
}

/** "YYYY-MM-DD" of the local day containing `ms`. */
export function localDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight starting the day containing `ms`. */
function startOfDay(ms: number): number {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight `n` days after the one starting at `dayStart` (DST-safe). */
function addDays(dayStart: number, n: number): number {
	const d = new Date(dayStart);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** Study minutes per local date, and the set of dates with a learner message. */
export function studyTime(sessions: ReadonlyArray<ReadonlyArray<{ role?: string; timestamp?: number }>>): {
	minutesByDate: Map<string, number>;
	studyDates: Set<string>;
} {
	const minutesByDate = new Map<string, number>();
	const studyDates = new Set<string>();
	for (const messages of sessions) {
		const times = messages
			.map((m) => m.timestamp)
			.filter((t): t is number => typeof t === "number" && t > 0)
			.sort((a, b) => a - b);
		for (const m of messages) {
			if (m.role === "user" && typeof m.timestamp === "number" && m.timestamp > 0) studyDates.add(localDate(m.timestamp));
		}
		for (let i = 1; i < times.length; i++) {
			const gap = Math.min(IDLE_CAP_MS, times[i]! - times[i - 1]!);
			const key = localDate(times[i]!);
			minutesByDate.set(key, (minutesByDate.get(key) ?? 0) + gap / 60_000);
		}
	}
	return { minutesByDate, studyDates };
}

/** Current streak (ending today, or yesterday if today is still empty) and the longest ever. */
export function streaks(studyDates: ReadonlySet<string>, now: number): { current: number; longest: number; today: boolean } {
	const today = startOfDay(now);
	const studiedToday = studyDates.has(localDate(today));
	let current = 0;
	for (let day = studiedToday ? today : addDays(today, -1); studyDates.has(localDate(day)); day = addDays(day, -1)) current++;

	let longest = 0;
	let run = 0;
	let prev: number | null = null;
	for (const date of [...studyDates].sort()) {
		const [y, m, d] = date.split("-").map(Number);
		const day = new Date(y!, m! - 1, d!).getTime();
		run = prev !== null && addDays(prev, 1) === day ? run + 1 : 1;
		longest = Math.max(longest, run);
		prev = day;
	}
	return { current, longest: Math.max(longest, current), today: studiedToday };
}

export function studyStatsFrom(deps: ReviewDeps, now: number): StudyStats {
	const summaries = deps.chatStore.listChats();
	const transcripts: Array<ReadonlyArray<{ role?: string; timestamp?: number }>> = [];
	let practice = 0;
	for (const s of summaries) {
		if (s.kind === "practice") practice++;
		const chat = deps.chatStore.getChat(s.id);
		if (chat) transcripts.push(chat.messages as ReadonlyArray<{ role?: string; timestamp?: number }>);
	}
	const { minutesByDate, studyDates } = studyTime(transcripts);
	const streak = streaks(studyDates, now);

	const nodes = deps.graphStore.readNodes();
	const events = allReviewEvents(deps);
	const today = startOfDay(now);

	const reviewsByDate = new Map<string, number>();
	for (const e of events) reviewsByDate.set(localDate(e.at), (reviewsByDate.get(localDate(e.at)) ?? 0) + 1);

	const days: StudyStats["days"] = [];
	for (let i = 29; i >= 0; i--) {
		const date = localDate(addDays(today, -i));
		days.push({ date, minutes: Math.round(minutesByDate.get(date) ?? 0), reviews: reviewsByDate.get(date) ?? 0 });
	}

	const weeks: StudyStats["weeks"] = [];
	for (let w = 11; w >= 0; w--) {
		const start = addDays(today, -7 * w - 6);
		const end = addDays(today, -7 * w + 1);
		const inWeek = events.filter((e) => e.at >= start && e.at < end);
		const kept = inWeek.filter((e) => e.grade !== "again").length;
		weeks.push({
			start: localDate(start),
			reviews: inWeek.length,
			retention: inWeek.length ? kept / inWeek.length : null,
			ideasLearned: nodes.filter((n) => {
				const t = Date.parse(n.createdAt);
				return t >= start && t < end;
			}).length,
		});
	}

	const forecast: StudyStats["forecast"] = Array.from({ length: 14 }, (_, i) => ({ date: localDate(addDays(today, i)), due: 0 }));
	for (const s of reviewStates(nodes, events).values()) {
		if (s.dueAt < addDays(today, 1)) forecast[0]!.due++;
		else {
			const i = forecast.findIndex((_, k) => s.dueAt < addDays(today, k + 1));
			if (i > 0) forecast[i]!.due++;
		}
	}

	const sevenDaysAgo = localDate(addDays(today, -6));
	let minutesLast7Days = 0;
	let minutesTotal = 0;
	for (const [date, min] of minutesByDate) {
		minutesTotal += min;
		if (date >= sevenDaysAgo) minutesLast7Days += min;
	}
	const kept = events.filter((e) => e.grade !== "again").length;

	return {
		now,
		streakDays: streak.current,
		studiedToday: streak.today,
		longestStreak: streak.longest,
		minutesLast7Days: Math.round(minutesLast7Days),
		minutesTotal: Math.round(minutesTotal),
		sessions: { teach: summaries.length - practice, practice },
		ideas: nodes.length,
		reviews: { total: events.length, retention: events.length ? kept / events.length : null },
		days,
		weeks,
		forecast,
	};
}

