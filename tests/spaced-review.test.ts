/**
 * SPACED REVIEW PINS (fork, 2026-10-26): the forgetting curve, the grade
 * mapping, evidence extraction from practice records, and the fold.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyReview,
	dueItems,
	gradeFromConclude,
	initialState,
	recallAfter,
	reviewEventsFromMessages,
	reviewSnapshotFrom,
	reviewStates,
	type ReviewDeps,
} from "../src/core/review.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function assistantCall(id: string, name: string, args: unknown, timestamp: number): LhMessage {
	return { id: `m_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp } as unknown as LhMessage;
}
function result(id: string, isError = false): LhMessage {
	return { id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: "x", content: [], isError, timestamp: 0 } as unknown as LhMessage;
}

describe("forgetting curve", () => {
	it("recall is 90% exactly at stability, 100% at zero elapsed", () => {
		assert.equal(recallAfter(5, 0), 1);
		assert.ok(Math.abs(recallAfter(5, 5) - 0.9) < 1e-12);
		assert.ok(recallAfter(5, 10) < recallAfter(5, 5));
	});
	it("a new proposition is due one day after it is learned", () => {
		const s = initialState("n_a", T0);
		assert.equal(s.dueAt, T0 + DAY);
		assert.equal(s.practiced, false);
	});
});

describe("grades from practice outcomes", () => {
	it("maps outcome + rung", () => {
		assert.equal(gradeFromConclude("solved", null), "easy");
		assert.equal(gradeFromConclude("solved", "R1"), "good");
		assert.equal(gradeFromConclude("solved", "R3"), "hard");
		assert.equal(gradeFromConclude("solvedWithHints", "R2"), "hard");
		assert.equal(gradeFromConclude("surrendered", null), "again");
		assert.equal(gradeFromConclude("dismissed", null), "again");
		assert.equal(gradeFromConclude("bogus", null), null);
	});
});

describe("scheduling", () => {
	it("success grows the interval; easy grows it most; a lapse shrinks it", () => {
		const s = initialState("n", T0);
		const at = T0 + DAY;
		const hard = applyReview(s, "hard", at);
		const good = applyReview(s, "good", at);
		const easy = applyReview(s, "easy", at);
		const again = applyReview(s, "again", at);
		assert.ok(hard.stability > s.stability);
		assert.ok(good.stability > hard.stability);
		assert.ok(easy.stability > good.stability);
		assert.ok(again.stability < s.stability);
		assert.equal(again.lapses, 1);
		assert.ok(again.ease < s.ease);
	});
	it("the spacing effect: recalling after more decay grows stability more", () => {
		const s = initialState("n", T0);
		const early = applyReview(s, "good", T0 + DAY * 0.1);
		const late = applyReview(s, "good", T0 + DAY * 3);
		assert.ok(late.stability > early.stability);
	});
	it("good streaks push the next review out to weeks", () => {
		let s = initialState("n", T0);
		let at = T0;
		for (let i = 0; i < 4; i++) {
			at = s.dueAt;
			s = applyReview(s, "good", at);
		}
		assert.ok(s.stability > 14, `stability ${s.stability}`);
	});
});

describe("evidence from practice records", () => {
	it("a clean conclude grades every target of the clean problem before it", () => {
		const msgs = [
			assistantCall("p1", "problem", { statement: "…", mode: "recall", target: ["n_a", "n_b"], modelSolution: "…" }, T0),
			result("p1"),
			assistantCall("c1", "conclude", { outcome: "solved", verdict: "ok", rung: null, missClass: null, retest: false }, T0 + 1000),
			result("c1"),
		];
		const events = reviewEventsFromMessages("chat_x", msgs);
		assert.deepEqual(
			events.map((e) => [e.nodeId, e.grade, e.at]),
			[
				["n_a", "easy", T0 + 1000],
				["n_b", "easy", T0 + 1000],
			],
		);
	});
	it("errored calls and untagged problems produce nothing", () => {
		const msgs = [
			assistantCall("p1", "problem", { target: ["n_a"] }, T0),
			result("p1", true),
			assistantCall("c1", "conclude", { outcome: "solved", rung: null }, T0),
			result("c1"),
			assistantCall("p2", "problem", { statement: "untagged" }, T0),
			result("p2"),
			assistantCall("c2", "conclude", { outcome: "surrendered", rung: null }, T0),
			result("c2"),
		];
		assert.deepEqual(reviewEventsFromMessages("c", msgs), []);
	});
});

describe("the fold + snapshot", () => {
	it("unpracticed propositions come due; a fresh clean review clears them", () => {
		const nodes = [
			{ id: "n_a", name: "A", statement: "a", createdAt: new Date(T0).toISOString() },
			{ id: "n_b", name: "B", statement: "b", createdAt: new Date(T0).toISOString() },
		];
		const now = T0 + 3 * DAY;
		const states = reviewStates(nodes, [{ nodeId: "n_a", at: now - 1000, grade: "good", chatId: "c" }]);
		assert.deepEqual(
			dueItems(states.values(), now).map((i) => i.nodeId),
			["n_b"],
		);
	});
	it("snapshot reads practice sessions only, through the ports", () => {
		const practiceMsgs = [
			assistantCall("p1", "problem", { target: ["n_a"] }, T0 + DAY),
			result("p1"),
			assistantCall("c1", "conclude", { outcome: "surrendered", rung: null }, T0 + DAY),
			result("c1"),
		];
		const deps: ReviewDeps = {
			chatStore: {
				listChats: () => [
					{ id: "c_p", kind: "practice" },
					{ id: "c_t", kind: "teach" },
				],
				getChat: (id) => ({ id, messages: id === "c_p" ? practiceMsgs : practiceMsgs }),
			},
			graphStore: { readNodes: () => [{ id: "n_a", name: "A", statement: "a", createdAt: new Date(T0).toISOString() }] },
		};
		const snap = reviewSnapshotFrom(deps, T0 + 2 * DAY);
		assert.equal(snap.due.length, 1);
		assert.equal(snap.due[0]!.lapses, 1); // the teach session was not counted
		assert.equal(snap.due[0]!.name, "A");
	});
});
