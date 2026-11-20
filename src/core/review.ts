/**
 * SPACED REVIEW — knowledge decay over the graph (fork addition, 2026-10-26).
 *
 * The problem it solves: solving a problem today says little about two
 * weeks from now. Following Anki's principle, every proposition carries a
 * MEMORY STABILITY (days until recall probability falls to 90%), and the
 * agent revisits propositions whose predicted recall has decayed.
 *
 * Fits the architecture's law ("writes point to append-only evidence, and
 * everything else is derived"): NOTHING here is stored. The evidence already
 * exists — every practice `conclude` (outcome + hint rung) sits in the
 * session records, tied to the proposition ids its `problem` targeted. The
 * schedule is a pure replay of that evidence, rebuilt on every read, and the
 * graph itself stays free of ability ratings (vision §1).
 *
 * The model (a compact FSRS-style forgetting curve):
 *   recall(t) = 0.9 ^ (t / stability)          t = days since last review
 * so recall is exactly 90% when t = stability — that moment is "due".
 *   - Learning (the node's creation) seeds stability at 1 day: a freshly
 *     taught idea is reviewed the next day, exactly like a new Anki card.
 *   - A successful review MULTIPLIES stability. The multiplier grows with
 *     ease and with how much had been forgotten (recalling at 60% teaches
 *     the memory more than recalling at 99% — the spacing effect).
 *   - A lapse (gave up / moved on / dismissed) cuts stability hard and
 *     makes the proposition harder (lower ease) from then on.
 *
 * Pure + browser-safe: no IO, no node builtins.
 */

import type { LhMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL } from "./native-messages.ts";

const DAY_MS = 86_400_000;

/** Recall probability at which a proposition becomes due. */
export const REVIEW_TARGET_RECALL = 0.9;

/** How a review went, Anki-style. */
export type ReviewGrade = "again" | "hard" | "good" | "easy";

/** One review of one proposition — derived from a practice conclude. */
export interface ReviewEvent {
	nodeId: string;
	/** ms epoch of the conclude. */
	at: number;
	grade: ReviewGrade;
	/** The practice session the review happened in. */
	chatId: string;
}

/** The derived memory state of one proposition. */
export interface ReviewState {
	nodeId: string;
	/** Days until predicted recall drops to REVIEW_TARGET_RECALL. */
	stability: number;
	/** SM-2-style ease factor, 1.3 – 3.0: how fast stability grows. */
	ease: number;
	/** Successful reviews in a row (resets on a lapse). */
	streak: number;
	/** Total reviews and lapses ever. */
	reviews: number;
	lapses: number;
	/** ms epoch of the last learning/review event. */
	lastAt: number;
	/** ms epoch when recall decays to REVIEW_TARGET_RECALL. */
	dueAt: number;
	/** True once a practice review exists (false = only learned so far). */
	practiced: boolean;
}

// ─── Grading: practice outcome → review grade ───────────────────────────────

/** Map a conclude's outcome + hint rung to a review grade. Unknown outcomes
 *  return null (not evidence). */
export function gradeFromConclude(outcome: unknown, rung: unknown): ReviewGrade | null {
	switch (outcome) {
		case "solved":
			// No hint at all = easy; a light nudge (R0/R1) = good; more = hard.
			if (rung === null || rung === undefined) return "easy";
			return rung === "R0" || rung === "R1" ? "good" : "hard";
		case "solvedWithHints":
			return "hard";
		case "movedOn":
		case "surrendered":
		case "dismissed":
			return "again";
		default:
			return null;
	}
}

// ─── Evidence: session records → review events ──────────────────────────────

/** Extract review events from one practice session's messages: each CLEAN
 *  conclude grades every proposition its CLEAN problem targeted. Untagged
 *  problems (no target) produce no events — nothing to schedule. */
export function reviewEventsFromMessages(chatId: string, messages: readonly LhMessage[]): ReviewEvent[] {
	const clean = new Set<string>();
	for (const m of messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && !r.isError && r.toolCallId) clean.add(r.toolCallId);
	}
	const events: ReviewEvent[] = [];
	let activeTargets: string[] | null = null;
	for (const m of messages) {
		const a = m as { role?: string; timestamp?: number; content?: unknown };
		if (a.role !== "assistant" || !Array.isArray(a.content)) continue;
		for (const block of a.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || !block.id || !clean.has(block.id)) continue;
			const args = (block.arguments ?? {}) as Record<string, unknown>;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				activeTargets = Array.isArray(args.target)
					? args.target.filter((t): t is string => typeof t === "string")
					: [];
			} else if (block.name === PRACTICE_CONCLUDE_TOOL) {
				const grade = gradeFromConclude(args.outcome, args.rung);
				if (grade && activeTargets) {
					const at = typeof a.timestamp === "number" ? a.timestamp : 0;
					for (const nodeId of activeTargets) events.push({ nodeId, at, grade, chatId });
				}
				activeTargets = null;
			}
		}
	}
	return events;
}

// ─── The scheduler: a pure fold over events ─────────────────────────────────

/** Predicted recall probability `days` after the last review. */
export function recallAfter(stability: number, days: number): number {
	if (days <= 0) return 1;
	return Math.pow(REVIEW_TARGET_RECALL, days / Math.max(stability, 0.01));
}

/** A freshly learned proposition: due one day after it was learned. */
export function initialState(nodeId: string, learnedAt: number): ReviewState {
	return {
		nodeId,
		stability: 1,
		ease: 2.5,
		streak: 0,
		reviews: 0,
		lapses: 0,
		lastAt: learnedAt,
		dueAt: learnedAt + DAY_MS,
		practiced: false,
	};
}

/** Apply one review to a state (pure). */
export function applyReview(state: ReviewState, grade: ReviewGrade, at: number): ReviewState {
	const elapsedDays = Math.max(0, (at - state.lastAt) / DAY_MS);
	const recall = recallAfter(state.stability, elapsedDays);
	let { stability, ease, streak, lapses } = state;
	if (grade === "again") {
		lapses += 1;
		streak = 0;
		ease = Math.max(1.3, ease - 0.2);
		// Keep a sliver of the old memory; relearning is faster than learning.
		stability = Math.max(0.5, stability * 0.3);
	} else {
		streak += 1;
		if (grade === "hard") ease = Math.max(1.3, ease - 0.15);
		if (grade === "easy") ease = Math.min(3.0, ease + 0.15);
		const gradeFactor = grade === "hard" ? 0.6 : grade === "easy" ? 1.3 : 1;
		// The spacing effect: the more had decayed, the bigger the gain.
		const spacingBonus = 1 + (1 - recall) * 2;
		const growth = Math.max(1.2, ease * gradeFactor * spacingBonus);
		stability = Math.min(3650, stability * growth);
	}
	return {
		...state,
		stability,
		ease,
		streak,
		lapses,
		reviews: state.reviews + 1,
		lastAt: at,
		dueAt: at + stability * DAY_MS,
		practiced: true,
	};
}

/** Every proposition's memory state: seeded at its creation (learning),
 *  then folded over its review events in time order. Events for unknown
 *  nodes (deleted propositions) are ignored. */
export function reviewStates(
	nodes: ReadonlyArray<{ id: string; createdAt: string }>,
	events: readonly ReviewEvent[],
): Map<string, ReviewState> {
	const states = new Map<string, ReviewState>();
	for (const n of nodes) {
		const t = Date.parse(n.createdAt);
		states.set(n.id, initialState(n.id, Number.isFinite(t) ? t : 0));
	}
	const sorted = [...events].sort((a, b) => a.at - b.at);
	for (const e of sorted) {
		const s = states.get(e.nodeId);
		if (s) states.set(e.nodeId, applyReview(s, e.grade, Math.max(e.at, s.lastAt)));
	}
	return states;
}

// ─── The queue: what to review now ──────────────────────────────────────────

export interface ReviewItem extends ReviewState {
	/** Predicted recall right now, 0–1. */
	recallNow: number;
	/** Days overdue (negative = due in the future). */
	overdueDays: number;
}

/** States annotated for `now`, MOST URGENT first (lowest predicted recall). */
export function reviewQueue(states: Iterable<ReviewState>, now: number): ReviewItem[] {
	const items: ReviewItem[] = [];
	for (const s of states) {
		items.push({
			...s,
			recallNow: recallAfter(s.stability, (now - s.lastAt) / DAY_MS),
			overdueDays: (now - s.dueAt) / DAY_MS,
		});
	}
	return items.sort((a, b) => a.recallNow - b.recallNow);
}

/** Only the items due at `now`. */
export function dueItems(states: Iterable<ReviewState>, now: number): ReviewItem[] {
	return reviewQueue(states, now).filter((i) => i.dueAt <= now);
}

/** Human phrase for an interval, e.g. "in 3 days", "2 weeks ago". */
export function describeDue(dueAt: number, now: number): string {
	const days = (dueAt - now) / DAY_MS;
	const abs = Math.abs(days);
	const unit =
		abs < 1 / 24 ? "now" : abs < 1 ? `${Math.round(abs * 24)}h` : abs < 14 ? `${Math.round(abs)}d` : abs < 60 ? `${Math.round(abs / 7)}w` : `${Math.round(abs / 30)}mo`;
	if (unit === "now") return "due now";
	return days < 0 ? `overdue ${unit}` : `in ${unit}`;
}

// ─── Snapshot over the storage ports (shared by server + agent tools) ───────

/** The reads a snapshot needs — structurally the ChatStore/GraphStore ports. */
export interface ReviewDeps {
	chatStore: {
		listChats(): ReadonlyArray<{ id: string; kind: string }>;
		getChat(id: string): { id: string; messages: LhMessage[] } | null;
	};
	graphStore: { readNodes(): ReadonlyArray<{ id: string; name: string; statement: string; createdAt: string }> };
}

export interface ReviewQueueItem extends ReviewItem {
	name: string;
	statement: string;
	/** "overdue 3d" / "in 5d" / "due now". */
	when: string;
}

export interface ReviewSnapshot {
	now: number;
	/** Due right now, most decayed first. */
	due: ReviewQueueItem[];
	/** Not yet due, soonest first. */
	upcoming: ReviewQueueItem[];
}

/** Every review event across all practice sessions. */
export function allReviewEvents(deps: ReviewDeps): ReviewEvent[] {
	const events: ReviewEvent[] = [];
	for (const summary of deps.chatStore.listChats()) {
		if (summary.kind !== "practice") continue;
		const chat = deps.chatStore.getChat(summary.id);
		if (chat) events.push(...reviewEventsFromMessages(chat.id, chat.messages));
	}
	return events;
}

/** The whole review picture at `now`. */
export function reviewSnapshotFrom(deps: ReviewDeps, now: number): ReviewSnapshot {
	const nodes = deps.graphStore.readNodes();
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const items = reviewQueue(reviewStates(nodes, allReviewEvents(deps)).values(), now).map((i) => ({
		...i,
		name: byId.get(i.nodeId)?.name ?? i.nodeId,
		statement: byId.get(i.nodeId)?.statement ?? "",
		when: describeDue(i.dueAt, now),
	}));
	return {
		now,
		due: items.filter((i) => i.dueAt <= now),
		upcoming: items.filter((i) => i.dueAt > now).sort((a, b) => a.dueAt - b.dueAt),
	};
}

/** The agents' view: a compact text block (ids first, so `problem` can
 *  target them). */
export function reviewSnapshotText(snapshot: ReviewSnapshot, limit = 20): string {
	const { due, upcoming } = snapshot;
	if (due.length === 0 && upcoming.length === 0) return "The knowledge graph has no propositions yet — nothing to review.";
	const line = (i: ReviewQueueItem) =>
		`- [${i.nodeId}] ${i.name} — recall ≈${Math.round(i.recallNow * 100)}%, ${i.when}, ` +
		`${i.reviews} review${i.reviews === 1 ? "" : "s"}${i.lapses ? `, ${i.lapses} lapse${i.lapses === 1 ? "" : "s"}` : ""}` +
		(i.practiced ? "" : " (learned, never practiced)");
	const parts: string[] = [];
	parts.push(
		due.length > 0
			? `${due.length} proposition(s) DUE for review (predicted recall below 90%), most decayed first:\n${due.slice(0, limit).map(line).join("\n")}` +
					(due.length > limit ? `\n…and ${due.length - limit} more` : "")
			: "Nothing is due for review right now.",
	);
	if (upcoming.length > 0) parts.push(`Next up:\n${upcoming.slice(0, 5).map(line).join("\n")}`);
	return parts.join("\n\n");
}
