"use client";

import { useEffect, useState } from "react";
import { RotateCcwIcon, TerminalIcon } from "lucide-react";

/**
 * Home-composer extras (fork, 2026-10-26):
 *  - the REVIEW PILL: how many propositions have decayed below 90%
 *    predicted recall (GET /api/review); clicking it loads them as practice
 *    picks — a spaced-review session is just a practice session over the
 *    most-faded propositions;
 *  - the TOOL CHIPS (practice mode only): the learner's CLI tools from
 *    data/tools/*.json (GET /api/cli-tools) to attach to the new session.
 */

export interface DuePick {
	id: string;
	name: string;
	statement: string;
}

interface ReviewResponse {
	due: Array<{ nodeId: string; name: string; statement: string }>;
}

interface CliToolsResponse {
	dir: string;
	tools: Array<{ name: string; description: string; default: boolean; sandbox: boolean }>;
	errors: Record<string, string[]>;
}

/** Max propositions one review session picks (most decayed first). */
export const REVIEW_SESSION_SIZE = 12;

export function useReviewDue(): DuePick[] {
	const [due, setDue] = useState<DuePick[]>([]);
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetch("/api/review")
				.then((r) => r.json() as Promise<ReviewResponse>)
				.then((r) => {
					if (alive) setDue(r.due.map((d) => ({ id: d.nodeId, name: d.name, statement: d.statement })));
				})
				.catch(() => {});
		void load();
		const t = setInterval(load, 5 * 60_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);
	return due;
}

export function ReviewPill({ due, onReview }: { due: readonly DuePick[]; onReview: () => void }) {
	if (due.length === 0) return null;
	return (
		<button
			type="button"
			data-testid="review-pill"
			onClick={onReview}
			title="Propositions whose predicted recall has dropped below 90% — practice them before they fade"
			className="flex items-center gap-1.5 rounded-sm border border-border bg-card px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
		>
			<RotateCcwIcon aria-hidden="true" className="size-3" />
			{due.length} due for review
		</button>
	);
}

export function useCliTools(): { tools: CliToolsResponse["tools"]; dir: string; selected: Set<string>; toggle: (name: string) => void } {
	const [data, setData] = useState<CliToolsResponse>({ dir: "", tools: [], errors: {} });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	useEffect(() => {
		fetch("/api/cli-tools")
			.then((r) => r.json() as Promise<CliToolsResponse>)
			.then((r) => {
				setData(r);
				setSelected(new Set(r.tools.filter((t) => t.default).map((t) => t.name)));
			})
			.catch(() => {});
	}, []);
	const toggle = (name: string) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	return { tools: data.tools, dir: data.dir, selected, toggle };
}

export function ToolChips({
	tools,
	dir,
	selected,
	toggle,
}: {
	tools: CliToolsResponse["tools"];
	dir: string;
	selected: ReadonlySet<string>;
	toggle: (name: string) => void;
}) {
	if (tools.length === 0) {
		return dir ? (
			<span className="font-ui text-[11px] text-muted-foreground" title={`Add JSON tool manifests to ${dir}`}>
				<TerminalIcon aria-hidden="true" className="mr-1 inline size-3" />
				no tools — add manifests to {dir}
			</span>
		) : null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1" data-testid="tool-chips">
			<TerminalIcon aria-hidden="true" className="size-3 text-muted-foreground" />
			{tools.map((t) => (
				<button
					key={t.name}
					type="button"
					title={t.description}
					onClick={() => toggle(t.name)}
					data-on={selected.has(t.name)}
					className="rounded-sm border border-border px-2 py-0.5 font-ui text-[11px] text-muted-foreground transition-colors data-[on=true]:border-primary/60 data-[on=true]:bg-accent data-[on=true]:text-foreground hover:text-foreground cursor-pointer"
				>
					{t.name}
				</button>
			))}
		</div>
	);
}
