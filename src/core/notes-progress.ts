/**
 * NOTES PROGRESS — checklist progress across the vault for the /stats page.
 *
 * Derived, never stored. A task's completion day is its "✅ YYYY-MM-DD"
 * stamp (written when a box is checked in Meander, or by Obsidian Tasks);
 * a done task without one counts on its note's last-edit day.
 *
 * Pure + browser-safe. Days are the host's local calendar days.
 */

import { extractTasks, taskDoneDate } from "./notes.ts";
import { localDate } from "./study-stats.ts";

export interface NotesProgress {
	totals: { notes: number; done: number; total: number; doneLast7Days: number };
	/** Notes with at least one task, most recently edited first. */
	notes: Array<{ path: string; title: string; folder: string; done: number; total: number; mtime: number }>;
	/** The last 30 days, oldest first. */
	days: Array<{ date: string; done: number }>;
}

function dayOffset(now: number, n: number): string {
	const d = new Date(now);
	return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime());
}

export function notesProgressFrom(
	notes: ReadonlyArray<{ path: string; title: string; mtime: number; text: string }>,
	now: number,
	opts: { skipFolders?: string[] } = {},
): NotesProgress {
	const skip = (opts.skipFolders ?? []).filter(Boolean).map((f) => f.replace(/\/+$/, "") + "/");
	const doneByDate = new Map<string, number>();
	const rows: NotesProgress["notes"] = [];
	for (const n of notes) {
		if (skip.some((f) => n.path.startsWith(f))) continue;
		const tasks = extractTasks(n.text);
		if (!tasks.length) continue;
		let done = 0;
		for (const t of tasks) {
			if (!t.done) continue;
			done++;
			const date = taskDoneDate(t.text) ?? localDate(n.mtime);
			doneByDate.set(date, (doneByDate.get(date) ?? 0) + 1);
		}
		const slash = n.path.lastIndexOf("/");
		rows.push({ path: n.path, title: n.title, folder: slash < 0 ? "" : n.path.slice(0, slash), done, total: tasks.length, mtime: n.mtime });
	}
	rows.sort((a, b) => b.mtime - a.mtime);

	const days: NotesProgress["days"] = [];
	for (let i = 29; i >= 0; i--) {
		const date = dayOffset(now, -i);
		days.push({ date, done: doneByDate.get(date) ?? 0 });
	}
	const weekAgo = dayOffset(now, -6);
	const today = dayOffset(now, 0);
	let doneLast7Days = 0;
	for (const [date, c] of doneByDate) if (date >= weekAgo && date <= today) doneLast7Days += c;

	return {
		totals: {
			notes: rows.length,
			done: rows.reduce((s, r) => s + r.done, 0),
			total: rows.reduce((s, r) => s + r.total, 0),
			doneLast7Days,
		},
		notes: rows,
		days,
	};
}
