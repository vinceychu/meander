/**
 * Spaced review — the server composition (fork, 2026-10-26): the pure
 * snapshot (core/review.ts) over the wired storage ports. Read-only.
 * Also the /stats numbers and the Anki deck (fork, 2026-10-27).
 */

import { ankiExportText } from "../core/anki.ts";
import { reviewSnapshotFrom, type ReviewSnapshot } from "../core/review.ts";
import { studyStatsFrom, type StudyStats } from "../core/study-stats.ts";
import { stores } from "./stores.ts";

export function reviewSnapshot(now: number = Date.now()): ReviewSnapshot {
	return reviewSnapshotFrom(stores, now);
}

export function studyStats(now: number = Date.now()): StudyStats {
	return studyStatsFrom(stores, now);
}

/** The whole graph as an Anki import file; currently-due propositions tagged lh_due. */
export function ankiExport(now: number = Date.now()): string {
	const due = new Set(reviewSnapshot(now).due.map((d) => d.nodeId));
	return ankiExportText(stores.graphStore.readNodes(), due);
}
