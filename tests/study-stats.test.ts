/**
 * STUDY STATS + ANKI EXPORT + FOLDER NOTES PINS (fork, 2026-10-27).
 * Timestamps are built from LOCAL dates so the day buckets hold in any TZ.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ankiExportText, ankiField } from "../src/core/anki.ts";
import { IDLE_CAP_MS, localDate, streaks, studyStatsFrom, studyTime } from "../src/core/study-stats.ts";
import type { ReviewDeps } from "../src/core/review.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "../src/core/native-messages.ts";

const at = (d: number, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, local

describe("study time", () => {
	it("sums message gaps, capping each idle gap at 5 minutes", () => {
		const { minutesByDate, studyDates } = studyTime([
			[
				{ role: "user", timestamp: at(10, 12, 0) },
				{ role: "assistant", timestamp: at(10, 12, 2) },
				{ role: "user", timestamp: at(10, 12, 3) },
				{ role: "assistant", timestamp: at(10, 20, 0) }, // left open for hours
			],
		]);
		assert.equal(minutesByDate.get(localDate(at(10))), 2 + 1 + IDLE_CAP_MS / 60_000);
		assert.deepEqual([...studyDates], [localDate(at(10))]);
	});
});

describe("streaks", () => {
	const dates = new Set([at(1), at(2), at(3), at(7), at(8), at(9)].map(localDate));
	it("counts back from today", () => {
		assert.deepEqual(streaks(dates, at(9, 18)), { current: 3, longest: 3, today: true });
	});
	it("an empty today keeps yesterday's streak alive", () => {
		assert.deepEqual(streaks(dates, at(10, 8)), { current: 3, longest: 3, today: false });
	});
	it("a missed day breaks it", () => {
		assert.equal(streaks(dates, at(11, 8)).current, 0);
	});
});

describe("studyStatsFrom", () => {
	function call(id: string, name: string, args: unknown, timestamp: number): LhMessage[] {
		return [
			{ id: `m_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp },
			{ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp },
		] as unknown as LhMessage[];
	}
	const practice: LhMessage[] = [
		{ id: "u1", role: "user", content: "go", timestamp: at(20, 10) } as unknown as LhMessage,
		...call("p1", PRACTICE_PROBLEM_TOOL, { target: ["n_a"] }, at(20, 10, 1)),
		...call("c1", PRACTICE_CONCLUDE_TOOL, { outcome: "solved", rung: null }, at(20, 10, 4)),
		...call("p2", PRACTICE_PROBLEM_TOOL, { target: ["n_b"] }, at(20, 10, 5)),
		...call("c2", PRACTICE_CONCLUDE_TOOL, { outcome: "surrendered", rung: null }, at(20, 10, 9)),
	];
	const deps: ReviewDeps = {
		chatStore: {
			listChats: () => [
				{ id: "c_p", kind: "practice" },
				{ id: "c_t", kind: "teach" },
			],
			getChat: (id) =>
				id === "c_p"
					? { id, messages: practice }
					: { id, messages: [{ id: "u", role: "user", content: "hi", timestamp: at(19, 9) } as unknown as LhMessage] },
		},
		graphStore: {
			readNodes: () => [
				{ id: "n_a", name: "A", statement: "a", createdAt: new Date(at(19, 9)).toISOString() },
				{ id: "n_b", name: "B", statement: "b", createdAt: new Date(at(19, 9)).toISOString() },
			],
		},
	};
	const stats = studyStatsFrom(deps, at(20, 18));

	it("counts sessions, ideas, streak and retention", () => {
		assert.deepEqual(stats.sessions, { teach: 1, practice: 1 });
		assert.equal(stats.ideas, 2);
		assert.equal(stats.streakDays, 2);
		assert.equal(stats.reviews.total, 2);
		assert.equal(stats.reviews.retention, 0.5, "one solve, one lapse");
		assert.equal(stats.minutesLast7Days, 9);
	});
	it("buckets 30 days, 12 weeks, and a 14-day forecast", () => {
		assert.equal(stats.days.length, 30);
		assert.equal(stats.days.at(-1)!.date, localDate(at(20)));
		assert.equal(stats.days.at(-1)!.reviews, 2);
		assert.equal(stats.weeks.length, 12);
		assert.equal(stats.weeks.at(-1)!.ideasLearned, 2);
		assert.equal(stats.weeks.at(-1)!.retention, 0.5);
		assert.equal(stats.forecast.length, 14);
		assert.equal(stats.forecast.reduce((s, d) => s + d.due, 0), 2, "every idea lands in the forecast window");
	});
});

describe("Anki export", () => {
	it("writes Anki's text-import headers and one note per proposition", () => {
		const text = ankiExportText(
			[
				{ id: "n_a", name: "Chain rule", statement: "If $y=f(g(x))$ then\ny' = f'(g(x))g'(x)" },
				{ id: "n_b", name: "A<B", statement: "tab\there" },
			],
			new Set(["n_b"]),
		);
		const lines = text.trimEnd().split("\n");
		assert.deepEqual(lines.slice(0, 6), ["#separator:tab", "#html:true", "#notetype:Basic", "#deck:Meander", "#guid column:1", "#tags column:4"]);
		assert.equal(lines.length, 8);
		assert.deepEqual(lines[6]!.split("\t"), ["lh-n_a", "Chain rule", "If \\(y=f(g(x))\\) then<br>y' = f'(g(x))g'(x)", "meander"]);
		assert.deepEqual(lines[7]!.split("\t"), ["lh-n_b", "A&lt;B", "tab here", "meander lh_due"]);
	});
	it("converts display math", () => {
		assert.equal(ankiField("$$a^2$$"), "\\[a^2\\]");
	});
});

describe("folder notes", async () => {
	process.env.LH_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-data-"));
	const { folderNotes } = await import("../src/server/import-folder.ts");
	it("lists text notes recursively, skipping hidden, empty and non-text files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-folder-"));
		fs.mkdirSync(path.join(dir, "sub"));
		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(path.join(dir, "a.md"), "# A");
		fs.writeFileSync(path.join(dir, "sub", "b.txt"), "B");
		fs.writeFileSync(path.join(dir, ".git", "c.md"), "C");
		fs.writeFileSync(path.join(dir, "empty.md"), "");
		fs.writeFileSync(path.join(dir, "pic.png"), "x");
		const r = folderNotes(dir);
		assert.deepEqual(r.files, [path.join(dir, "a.md"), path.join(dir, "sub", "b.txt")]);
		assert.deepEqual(r.skipped, []);
		assert.throws(() => folderNotes(path.join(dir, "a.md")), /not a folder/);
	});
});
