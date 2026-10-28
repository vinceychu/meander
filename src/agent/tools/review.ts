import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { reviewSnapshotFrom, reviewSnapshotText, type ReviewDeps } from "../../core/review.ts";

/**
 * THE REVIEW-QUEUE TOOL (fork, 2026-10-26): the agents' eyes on knowledge
 * decay. Lists the propositions whose predicted recall has fallen below 90%
 * (core/review.ts — derived from every past practice outcome), with ids the
 * practice `problem` tool can target. Registered on the practice agent
 * always, and on the prober alongside the map readers.
 */

const reviewQueueInput = Type.Object({
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 64, description: "Max due items to list (default 20)" })),
});

export function reviewQueueTool(deps: ReviewDeps): AgentTool<typeof reviewQueueInput> {
	return {
		name: "review_queue",
		label: "review_queue",
		description:
			"List the learner's propositions that are DUE for spaced review — predicted recall has decayed below 90% " +
			"since they were learned or last practiced — most decayed first, with ids, recall estimate, how overdue, " +
			"and review/lapse counts; plus the next few coming due. Ids are valid `problem` targets.",
		parameters: reviewQueueInput,
		execute: serverExecute("review_queue", reviewQueueInput, async ({ limit }): Promise<string> =>
			reviewSnapshotText(reviewSnapshotFrom(deps, Date.now()), limit ?? 20),
		),
	};
}
