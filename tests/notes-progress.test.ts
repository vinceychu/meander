/** Notes checklist progress + completion-date stamping on task toggle. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskDoneDate, toggleTaskLine, toggleTaskText } from "../src/core/notes.ts";
import { notesProgressFrom } from "../src/core/notes-progress.ts";

describe("toggleTaskText", () => {
	it("stamps today when checking and strips it when unchecking", () => {
		const on = toggleTaskText("- [ ] Problem 0", "2026-11-08");
		assert.equal(on, "- [x] Problem 0 ✅ 2026-11-08");
		assert.equal(toggleTaskText(on), "- [ ] Problem 0");
	});
	it("keeps an existing stamp and a trailing block id", () => {
		assert.equal(toggleTaskText("- [ ] a ✅ 2026-01-01", "2026-11-08"), "- [x] a ✅ 2026-01-01");
		assert.equal(toggleTaskText("- [ ] a ^blk", "2026-11-08"), "- [x] a ✅ 2026-11-08 ^blk");
	});
	it("without a date only flips the box; non-task lines are untouched", () => {
		assert.equal(toggleTaskText("  1. [ ] x"), "  1. [x] x");
		assert.equal(toggleTaskText("plain"), "plain");
		assert.equal(toggleTaskLine("a\n- [x] b\nc", 1), "a\n- [ ] b\nc");
	});
	it("reads the completion date", () => {
		assert.equal(taskDoneDate("done ✅ 2026-11-08"), "2026-11-08");
		assert.equal(taskDoneDate("done"), null);
	});
});

describe("notesProgressFrom", () => {
	const now = new Date(2026, 10, 8, 12).getTime();
	const notes = [
		{ path: "CS50/Week 0.md", title: "Week 0", mtime: new Date(2026, 10, 7, 9).getTime(), text: "- [x] indoor ✅ 2026-11-08\n- [x] playback\n- [ ] tip\n```\n- [ ] in code\n```" },
		{ path: "Ideas.md", title: "Ideas", mtime: now, text: "no tasks" },
		{ path: "Templates/Daily.md", title: "Daily", mtime: now, text: "- [ ] template" },
	];
	const p = notesProgressFrom(notes, now, { skipFolders: ["Templates"] });

	it("totals and per-note rows skip templates, task-less notes and code blocks", () => {
		assert.deepEqual(p.totals, { notes: 1, done: 2, total: 3, doneLast7Days: 2 });
		assert.deepEqual(p.notes.map((n) => [n.title, n.done, n.total, n.folder]), [["Week 0", 2, 3, "CS50"]]);
	});
	it("buckets by stamp, else by note mtime, over 30 days", () => {
		assert.equal(p.days.length, 30);
		assert.equal(p.days.at(-1)!.date, "2026-11-08");
		assert.equal(p.days.at(-1)!.done, 1);
		assert.equal(p.days.at(-2)!.done, 1);
	});
});
