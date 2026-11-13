"use client";
/**
 * Notes graph (2026-11-06): Obsidian's graph view on a canvas — notes as
 * nodes sized by link count, links as edges, optional tag and unresolved
 * nodes, color groups by folder, hover lights a node's neighborhood, click
 * opens. Local mode shows the active note's neighborhood to a chosen depth.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { Notes } from "@/src/core";
import { useAppearance } from "@/components/settings/appearance";

type Kind = "note" | "tag" | "ghost" | "attachment";
interface GNode extends SimulationNodeDatum {
	id: string;
	label: string;
	kind: Kind;
	degree: number;
	group: string;
}
type GLink = SimulationLinkDatum<GNode> & { source: string | GNode; target: string | GNode; related?: boolean };

const PALETTE = ["#5fb3a1", "#d38c5c", "#8f86d8", "#c9b458", "#d07aa6", "#6aa3d8", "#9cc06a", "#d06a6a"];
const NO_RELATED_EDGES: readonly { source: string; target: string; score: number }[] = [];

export function NotesGraph({
	index,
	active,
	local,
	depth = 1,
	onOpen,
	compact = false,
	relatedEdges = NO_RELATED_EDGES,
	showRelated = false,
	onShowRelatedChange,
	onOpenConnections,
}: {
	index: Notes.VaultIndex;
	active: string | null;
	local: boolean;
	depth?: number;
	onOpen: (path: string) => void;
	compact?: boolean;
	/** Dashed similarity edges. Drawn only when `showRelated` is on. */
	relatedEdges?: readonly { source: string; target: string; score: number }[];
	showRelated?: boolean;
	onShowRelatedChange?: (on: boolean) => void;
	/** Empty-vault prompt: focus the Connections panel. */
	onOpenConnections?: () => void;
}) {
	const wrap = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const { resolvedMode: theme } = useAppearance();
	const [showTags, setShowTags] = useState(false);
	const [showGhosts, setShowGhosts] = useState(!compact);
	const [showAttachments, setShowAttachments] = useState(false);
	const [orphans, setOrphans] = useState(true);
	const [filter, setFilter] = useState("");
	const [localDepth, setLocalDepth] = useState(depth);
	const noLinks = useMemo(() => Notes.noteLinkCount(index.notes) === 0, [index]);

	const data = useMemo(() => {
		const nodes = new Map<string, GNode>();
		const links: GLink[] = [];
		const folders = [...new Set(index.notes.map((n) => n.folder.split("/")[0] ?? ""))];
		const add = (id: string, label: string, kind: Kind, group = "") => {
			if (!nodes.has(id)) nodes.set(id, { id, label, kind, degree: 0, group });
			return nodes.get(id)!;
		};
		for (const n of index.notes) add(n.path, n.title, "note", n.folder.split("/")[0] ?? "");
		for (const n of index.notes) {
			for (const l of n.links) {
				if (l.path) {
					if (l.path === n.path) continue;
					if (!Notes.isNotePath(l.path)) {
						if (!showAttachments) continue;
						add(l.path, Notes.basename(l.path), "attachment");
					}
					links.push({ source: n.path, target: l.path });
				} else if (showGhosts && l.target) {
					add(`ghost:${l.target}`, l.target, "ghost");
					links.push({ source: n.path, target: `ghost:${l.target}` });
				}
			}
			if (showTags) for (const t of n.tags) {
				add(`tag:${t.toLowerCase()}`, `#${t}`, "tag");
				links.push({ source: n.path, target: `tag:${t.toLowerCase()}` });
			}
		}
		const pairKey = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
		const realPairs = new Set<string>();
		for (const l of links) {
			realPairs.add(pairKey(l.source as string, l.target as string));
			nodes.get(l.source as string)!.degree++;
			nodes.get(l.target as string)!.degree++;
		}
		if (showRelated) {
			const added = new Set<string>();
			for (const e of relatedEdges) {
				if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue;
				const key = pairKey(e.source, e.target);
				if (realPairs.has(key) || added.has(key)) continue;
				added.add(key);
				links.push({ source: e.source, target: e.target, related: true });
			}
		}
		// Degree stays "real links" so node size doesn't grow from suggestions.
		// A note that only has related edges is still connected, so Orphans-off keeps it.
		const linked = new Set<string>();
		for (const l of links) {
			linked.add(l.source as string);
			linked.add(l.target as string);
		}
		let keep: Set<string> | null = null;
		if (local && active) {
			keep = new Set([active]);
			for (let d = 0; d < localDepth; d++) {
				const frontier = [...keep];
				for (const l of links) {
					if (frontier.includes(l.source as string)) keep.add(l.target as string);
					if (frontier.includes(l.target as string)) keep.add(l.source as string);
				}
			}
		}
		const q = filter.trim().toLowerCase();
		let list = [...nodes.values()].filter((n) => (!keep || keep.has(n.id)) && (orphans || linked.has(n.id) || n.id === active) && (!q || n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)));
		const ids = new Set(list.map((n) => n.id));
		const ls = links.filter((l) => ids.has(l.source as string) && ids.has(l.target as string));
		list = list.map((n) => ({ ...n }));
		return { nodes: list, links: ls.map((l) => ({ ...l })), folders };
	}, [index, local, active, localDepth, showTags, showGhosts, showAttachments, orphans, filter, relatedEdges, showRelated]);

	useEffect(() => {
		const el = canvas.current;
		const box = wrap.current;
		if (!el || !box) return;
		const ctx = el.getContext("2d")!;
		const css = getComputedStyle(document.documentElement);
		const fg = css.getPropertyValue("--foreground").trim() || "#ddd";
		const muted = css.getPropertyValue("--muted-foreground").trim() || "#888";
		const border = css.getPropertyValue("--border").trim() || "#444";
		const accent = css.getPropertyValue("--lh-link").trim() || "#5fb3a1";
		let w = box.clientWidth;
		let h = box.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const resize = () => {
			w = box.clientWidth;
			h = box.clientHeight;
			el.width = w * dpr;
			el.height = h * dpr;
			el.style.width = `${w}px`;
			el.style.height = `${h}px`;
			draw();
		};
		let transform: ZoomTransform = zoomIdentity.translate(w / 2, h / 2);
		let hover: GNode | null = null;
		const nodes = data.nodes;
		const links = data.links;
		const neighbors = new Map<string, Set<string>>();
		for (const l of links) {
			const a = l.source as string;
			const b = l.target as string;
			(neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
			(neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
		}
		const radius = (n: GNode) => (n.kind === "tag" ? 3.5 : 3 + Math.sqrt(n.degree) * 1.6) * (compact ? 0.9 : 1);
		const color = (n: GNode) => {
			if (n.id === active) return accent;
			if (n.kind === "tag") return "#c9b458";
			if (n.kind === "ghost") return border;
			if (n.kind === "attachment") return "#8f86d8";
			const gi = data.folders.indexOf(n.group);
			return n.group && gi >= 0 ? PALETTE[gi % PALETTE.length]! : muted;
		};
		function draw() {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			ctx.save();
			ctx.translate(transform.x, transform.y);
			ctx.scale(transform.k, transform.k);
			const lit = hover ? neighbors.get(hover.id) ?? new Set() : null;
			ctx.lineWidth = 1 / Math.max(transform.k, 0.6);
			for (const l of links) {
				const s = l.source as GNode;
				const t = l.target as GNode;
				if (s.x === undefined || t.x === undefined) continue;
				const on = hover && (s.id === hover.id || t.id === hover.id);
				ctx.strokeStyle = on ? accent : l.related ? muted : border;
				ctx.globalAlpha = hover && !on ? 0.08 : on ? 0.95 : l.related ? 0.55 : 0.6;
				const dash = 4 / Math.max(transform.k, 0.4);
				ctx.setLineDash(l.related ? [dash, dash] : []);
				ctx.beginPath();
				ctx.moveTo(s.x, s.y!);
				ctx.lineTo(t.x, t.y!);
				ctx.stroke();
			}
			ctx.setLineDash([]);
			for (const n of nodes) {
				if (n.x === undefined) continue;
				const dim = hover && n.id !== hover.id && !lit!.has(n.id);
				ctx.globalAlpha = dim ? 0.12 : 1;
				ctx.fillStyle = hover && n.id === hover.id ? accent : color(n);
				ctx.beginPath();
				ctx.arc(n.x, n.y!, radius(n), 0, Math.PI * 2);
				ctx.fill();
				if (n.id === active) {
					ctx.strokeStyle = accent;
					ctx.lineWidth = 1.5 / transform.k;
					ctx.beginPath();
					ctx.arc(n.x, n.y!, radius(n) + 3, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
			// Labels fade in with zoom (and always for the hovered neighborhood).
			const labelAlpha = Math.min(1, Math.max(0, (transform.k - 0.7) / 0.6));
			ctx.font = `${11 / Math.max(transform.k, 0.8)}px ui-sans-serif, system-ui, sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			for (const n of nodes) {
				if (n.x === undefined) continue;
				const on = hover && (n.id === hover.id || lit!.has(n.id));
				const a = on ? 1 : hover ? 0 : n.id === active ? 1 : labelAlpha;
				if (a <= 0.02) continue;
				ctx.globalAlpha = a;
				ctx.fillStyle = n.kind === "ghost" ? muted : fg;
				ctx.fillText(n.label.length > 40 ? n.label.slice(0, 38) + "…" : n.label, n.x, n.y! + radius(n) + 3);
			}
			ctx.restore();
			ctx.globalAlpha = 1;
		}
		const sim = forceSimulation<GNode>(nodes)
			.force(
				"link",
				forceLink<GNode, GLink>(links)
					.id((d) => d.id)
					.distance((l) => (l.related ? (compact ? 70 : 110) : compact ? 40 : 60))
					.strength((l) => (l.related ? 0.15 : 0.6)),
			)
			.force("charge", forceManyBody().strength(compact ? -60 : -110))
			.force("center", forceCenter(0, 0))
			.force("x", forceX(0).strength(0.04))
			.force("y", forceY(0).strength(0.04))
			.force("collide", forceCollide<GNode>().radius((n) => radius(n) + 4))
			.on("tick", draw);
		if (nodes.length > 1500) sim.alphaDecay(0.06);
		const find = (mx: number, my: number) => {
			const [x, y] = transform.invert([mx, my]);
			let best: GNode | null = null;
			let bd = Infinity;
			for (const n of nodes) {
				const d = Math.hypot((n.x ?? 0) - x, (n.y ?? 0) - y);
				if (d < radius(n) + 6 / transform.k && d < bd) {
					bd = d;
					best = n;
				}
			}
			return best;
		};
		const sel = select(el);
		const z = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.1, 6])
			.on("zoom", (e: { transform: ZoomTransform }) => {
				transform = e.transform;
				draw();
			});
		sel.call(z).call(z.transform, zoomIdentity.translate(w / 2, h / 2).scale(compact ? 0.9 : 1));
		let drag: GNode | null = null;
		const onMove = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			if (drag) {
				const [x, y] = transform.invert([e.clientX - r.left, e.clientY - r.top]);
				drag.fx = x;
				drag.fy = y;
				sim.alphaTarget(0.2).restart();
				return;
			}
			const n = find(e.clientX - r.left, e.clientY - r.top);
			if (n !== hover) {
				hover = n;
				el.style.cursor = n ? "pointer" : "grab";
				draw();
			}
		};
		let downAt = { x: 0, y: 0 };
		const onDown = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			downAt = { x: e.clientX, y: e.clientY };
			const n = find(e.clientX - r.left, e.clientY - r.top);
			if (n) {
				drag = n;
				e.stopImmediatePropagation();
			}
		};
		const onUp = (e: PointerEvent) => {
			if (drag) {
				const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
				const n = drag;
				drag.fx = null;
				drag.fy = null;
				drag = null;
				sim.alphaTarget(0);
				if (!moved && n.kind === "note") onOpen(n.id);
				else if (!moved && n.kind === "attachment") onOpen(n.id);
			}
		};
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerdown", onDown, { capture: true });
		window.addEventListener("pointerup", onUp);
		const ro = new ResizeObserver(resize);
		ro.observe(box);
		resize();
		return () => {
			sim.stop();
			ro.disconnect();
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerdown", onDown, { capture: true });
			window.removeEventListener("pointerup", onUp);
			sel.on(".zoom", null);
		};
	}, [data, active, theme, compact, onOpen]);

	return (
		<div className="relative h-full w-full overflow-hidden" ref={wrap} data-testid={local ? "notes-local-graph" : "notes-graph"}>
			<canvas ref={canvas} className="block touch-none" />
			{!compact && !local && noLinks && (
				<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
					<div className="pointer-events-auto max-w-sm rounded-lg border bg-popover/95 p-4 text-center shadow-lg backdrop-blur" data-testid="notes-graph-empty">
						<p className="font-ui text-xs leading-relaxed text-foreground">No links yet — type [[ in a note to link it, or use Connections → Related to link suggestions</p>
						{onOpenConnections && (
							<button type="button" onClick={onOpenConnections} className="mt-3 rounded-md bg-primary px-3 py-1.5 font-ui text-xs font-medium text-primary-foreground hover:opacity-90">
								Open Connections
							</button>
						)}
					</div>
				</div>
			)}
			{!compact && (
				<div className="absolute right-3 top-3 z-20 flex w-52 flex-col gap-2 rounded-lg border bg-popover/95 p-3 font-ui text-xs shadow-lg backdrop-blur">
					<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter nodes…" className="rounded-md border bg-background px-2 py-1 text-xs" />
					<label className="flex items-center justify-between gap-2">
						Tags <input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)} />
					</label>
					<label className="flex items-center justify-between gap-2">
						Unresolved links <input type="checkbox" checked={showGhosts} onChange={(e) => setShowGhosts(e.target.checked)} />
					</label>
					<label className="flex items-center justify-between gap-2">
						Attachments <input type="checkbox" checked={showAttachments} onChange={(e) => setShowAttachments(e.target.checked)} />
					</label>
					<label className="flex items-center justify-between gap-2">
						Orphans <input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} />
					</label>
					{onShowRelatedChange && (
						<label className="flex items-center justify-between gap-2" title="Dashed lines between notes with similar text. On by itself when the vault has fewer than 10 links.">
							Related
							<input type="checkbox" checked={showRelated} onChange={(e) => onShowRelatedChange(e.target.checked)} />
						</label>
					)}
					{local && (
						<label className="flex items-center justify-between gap-2">
							Depth
							<input type="range" min={1} max={4} value={localDepth} onChange={(e) => setLocalDepth(Number(e.target.value))} />
						</label>
					)}
					<div className="text-[10px] text-muted-foreground">
						{data.nodes.length} nodes · {data.links.filter((l) => !l.related).length} links
						{showRelated ? ` · ${data.links.filter((l) => l.related).length} related` : ""}
					</div>
				</div>
			)}
		</div>
	);
}
