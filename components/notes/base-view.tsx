"use client";
/**
 * Bases (2026-11-06): database views over note properties, after Obsidian's
 * core plugin — table, cards and kanban (1.14) views, base-wide and per-view
 * filters (all/any), multi-key sort, group-by with a group menu to reorder
 * and hide groups (1.14), a search toolbar (1.12), computed formula columns,
 * a result limit with its notice (1.14). Cells edit the note's frontmatter
 * in place; dragging a kanban card to another column sets the group property.
 */
import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, EyeOffIcon, FilterIcon, LayoutGridIcon, PlusIcon, SearchIcon, SquareKanbanIcon, TableIcon, Trash2Icon, XIcon } from "lucide-react";
import { Notes } from "@/src/core";
import { cn } from "@/lib/utils";

const OPS: { op: Notes.FilterOp; label: string; needsProp: boolean; needsValue: boolean }[] = [
	{ op: "is", label: "is", needsProp: true, needsValue: true },
	{ op: "is-not", label: "is not", needsProp: true, needsValue: true },
	{ op: "contains", label: "contains", needsProp: true, needsValue: true },
	{ op: "not-contains", label: "does not contain", needsProp: true, needsValue: true },
	{ op: "starts-with", label: "starts with", needsProp: true, needsValue: true },
	{ op: "gt", label: ">", needsProp: true, needsValue: true },
	{ op: "lt", label: "<", needsProp: true, needsValue: true },
	{ op: "exists", label: "is not empty", needsProp: true, needsValue: false },
	{ op: "missing", label: "is empty", needsProp: true, needsValue: false },
	{ op: "has-tag", label: "has tag", needsProp: false, needsValue: true },
	{ op: "in-folder", label: "in folder", needsProp: false, needsValue: true },
	{ op: "links-to", label: "links to", needsProp: false, needsValue: true },
];

function fmtCell(prop: string, v: Notes.PropValue | undefined): string {
	if ((prop === "file.mtime" || prop === "file.ctime") && typeof v === "number") return new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	if (prop === "file.size" && typeof v === "number") return v < 1024 ? `${v} B` : `${(v / 1024).toFixed(1)} KB`;
	return Notes.propToText(v);
}

function label(prop: string): string {
	if (prop.startsWith("file.")) return prop.slice(5).replace("mtime", "modified").replace("ctime", "created");
	if (prop.startsWith("formula.")) return prop.slice(8);
	return prop;
}

const EDITABLE = (prop: string) => !prop.startsWith("file.") && !prop.startsWith("formula.");

export function BaseView({
	config,
	onConfig,
	notes,
	index,
	onOpen,
	onSetProp,
	onNewNote,
}: {
	config: Notes.BaseConfig;
	onConfig: (next: Notes.BaseConfig) => void;
	notes: Notes.NoteMeta[];
	index: Notes.VaultIndex;
	onOpen: (path: string) => void;
	onSetProp: (path: string, prop: string, value: Notes.PropValue) => void;
	onNewNote: (props: Notes.Props) => void;
}) {
	const [viewIdx, setViewIdx] = useState(0);
	const [search, setSearch] = useState("");
	const [panel, setPanel] = useState<null | "filters" | "columns" | "sort" | "group" | "formulas">(null);
	const [editing, setEditing] = useState<{ path: string; prop: string } | null>(null);
	const [dragPath, setDragPath] = useState<string | null>(null);
	const view = config.views[Math.min(viewIdx, config.views.length - 1)]!;
	const ctx = useMemo(() => ({ backlinks: index.backlinks, formulas: config.formulas }), [index.backlinks, config.formulas]);
	const result = useMemo(() => Notes.runBaseView(config, view, notes, ctx, search), [config, view, notes, ctx, search]);
	const allProps = useMemo(() => [...Notes.FILE_PROPS, ...Notes.allPropKeys(notes), ...Object.keys(config.formulas ?? {}).map((f) => `formula.${f}`)], [notes, config.formulas]);

	const setView = (patch: Partial<Notes.BaseView>) => {
		const views = config.views.map((v, i) => (i === viewIdx ? { ...v, ...patch } : v));
		onConfig({ ...config, views });
	};
	const sortBy = (prop: string) => {
		const cur = view.sort?.[0];
		setView({ sort: [{ prop, dir: cur?.prop === prop && cur.dir === "asc" ? "desc" : "asc" }] });
	};

	const cellEditor = (n: Notes.NoteMeta, prop: string, value: Notes.PropValue | undefined) => (
		<input
			autoFocus
			defaultValue={Notes.propToText(value)}
			className="w-full rounded border bg-background px-1 py-0.5 text-sm"
			onBlur={(e) => {
				commit(n, prop, e.currentTarget.value, value);
				setEditing(null);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") setEditing(null);
				e.stopPropagation();
			}}
		/>
	);
	const commit = (n: Notes.NoteMeta, prop: string, raw: string, old: Notes.PropValue | undefined) => {
		if (raw === Notes.propToText(old)) return;
		const v: Notes.PropValue = Array.isArray(old) ? raw.split(",").map((s) => s.trim()).filter(Boolean) : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
		onSetProp(n.path, prop, v);
	};

	const groupKey = view.groupBy ?? (view.type === "kanban" ? "status" : undefined);

	return (
		<div className="flex h-full flex-col" data-testid="base-view">
			{/* View tabs + toolbar */}
			<div className="flex flex-wrap items-center gap-1 border-b px-3 py-2 font-ui text-xs">
				{config.views.map((v, i) => (
					<button
						key={i}
						type="button"
						onClick={() => setViewIdx(i)}
						onDoubleClick={() => {
							const name = prompt("Rename view", v.name);
							if (name) onConfig({ ...config, views: config.views.map((x, j) => (j === i ? { ...x, name } : x)) });
						}}
						className={cn("flex items-center gap-1 rounded-md px-2 py-1", i === viewIdx ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}
					>
						{v.type === "table" ? <TableIcon className="size-3" /> : v.type === "cards" ? <LayoutGridIcon className="size-3" /> : <SquareKanbanIcon className="size-3" />}
						{v.name}
					</button>
				))}
				<button
					type="button"
					title="Add view"
					className="rounded-md p-1 text-muted-foreground hover:bg-accent"
					onClick={() => {
						onConfig({ ...config, views: [...config.views, { name: `View ${config.views.length + 1}`, type: "table", columns: [...view.columns], filters: [] }] });
						setViewIdx(config.views.length);
					}}
				>
					<PlusIcon className="size-3.5" />
				</button>
				<div className="ml-auto flex items-center gap-1">
					<div className="flex items-center gap-1 rounded-md border bg-background px-2 py-0.5">
						<SearchIcon className="size-3 text-muted-foreground" />
						<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search results" className="w-28 bg-transparent py-0.5 text-xs outline-none" />
					</div>
					<select
						value={view.type}
						onChange={(e) => setView({ type: e.target.value as Notes.BaseViewType, ...(e.target.value === "kanban" && !view.groupBy ? { groupBy: "status" } : {}) })}
						className="rounded-md border bg-background px-1.5 py-1 text-xs"
						aria-label="Layout"
					>
						<option value="table">Table</option>
						<option value="cards">Cards</option>
						<option value="kanban">Kanban</option>
					</select>
					{(["filters", "columns", "sort", "group", "formulas"] as const).map((p) => (
						<button
							key={p}
							type="button"
							onClick={() => setPanel(panel === p ? null : p)}
							className={cn("rounded-md px-2 py-1 capitalize", panel === p ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")}
						>
							{p === "filters" ? (
								<span className="flex items-center gap-1">
									<FilterIcon className="size-3" />
									{view.filters.length + config.filters.length || ""}
								</span>
							) : (
								p
							)}
						</button>
					))}
					{config.views.length > 1 && (
						<button
							type="button"
							title="Delete view"
							className="rounded-md p-1 text-muted-foreground hover:bg-accent"
							onClick={() => {
								onConfig({ ...config, views: config.views.filter((_, i) => i !== viewIdx) });
								setViewIdx(0);
							}}
						>
							<Trash2Icon className="size-3.5" />
						</button>
					)}
				</div>
			</div>

			{panel && (
				<div className="border-b bg-card/60 px-3 py-2 font-ui text-xs">
					{panel === "filters" && (
						<div className="flex flex-col gap-2">
							{([["This view", view.filters, view.match, (f: Notes.BaseFilter[], m?: "all" | "any") => setView({ filters: f, match: m ?? view.match })], ["All views", config.filters, config.match, (f: Notes.BaseFilter[], m?: "all" | "any") => onConfig({ ...config, filters: f, match: m ?? config.match })]] as const).map(([title, filters, match, set]) => (
								<div key={title} className="flex flex-col gap-1">
									<div className="flex items-center gap-2 text-muted-foreground">
										{title}: match
										<select value={match ?? "all"} onChange={(e) => set([...filters], e.target.value as "all" | "any")} className="rounded border bg-background px-1">
											<option value="all">all</option>
											<option value="any">any</option>
										</select>
									</div>
									{filters.map((f, i) => {
										const def = OPS.find((o) => o.op === f.op)!;
										const upd = (patch: Partial<Notes.BaseFilter>) => set(filters.map((x, j) => (j === i ? { ...x, ...patch } : x)));
										return (
											<div key={i} className="flex flex-wrap items-center gap-1">
												{def.needsProp && (
													<select value={f.prop} onChange={(e) => upd({ prop: e.target.value })} className="rounded border bg-background px-1 py-0.5">
														{allProps.map((p) => (
															<option key={p} value={p}>
																{p}
															</option>
														))}
													</select>
												)}
												<select value={f.op} onChange={(e) => upd({ op: e.target.value as Notes.FilterOp })} className="rounded border bg-background px-1 py-0.5">
													{OPS.map((o) => (
														<option key={o.op} value={o.op}>
															{o.label}
														</option>
													))}
												</select>
												{def.needsValue && <input value={f.value ?? ""} onChange={(e) => upd({ value: e.target.value })} className="w-40 rounded border bg-background px-1 py-0.5" />}
												<button type="button" onClick={() => set(filters.filter((_, j) => j !== i))} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
													<XIcon className="size-3" />
												</button>
											</div>
										);
									})}
									<button type="button" onClick={() => set([...filters, { prop: "file.name", op: "contains", value: "" }])} className="w-fit rounded px-1 text-muted-foreground hover:bg-accent">
										+ Add filter
									</button>
								</div>
							))}
						</div>
					)}
					{panel === "columns" && (
						<div className="flex flex-wrap gap-1">
							{allProps.map((p) => {
								const on = view.columns.includes(p);
								return (
									<button
										key={p}
										type="button"
										onClick={() => setView({ columns: on ? view.columns.filter((c) => c !== p) : [...view.columns, p] })}
										className={cn("rounded-full border px-2 py-0.5", on ? "border-foreground/50 bg-accent text-foreground" : "text-muted-foreground")}
									>
										{p}
									</button>
								);
							})}
							{view.type === "cards" && (
								<label className="ml-2 flex items-center gap-1 text-muted-foreground">
									Cover
									<select value={view.cover ?? ""} onChange={(e) => setView({ cover: e.target.value || undefined })} className="rounded border bg-background px-1">
										<option value="">none</option>
										{allProps.filter((p) => !p.startsWith("file.")).map((p) => (
											<option key={p}>{p}</option>
										))}
									</select>
								</label>
							)}
							<label className="ml-2 flex items-center gap-1 text-muted-foreground">
								Limit
								<input type="number" min={0} value={view.limit ?? ""} onChange={(e) => setView({ limit: e.target.value ? Number(e.target.value) : undefined })} className="w-16 rounded border bg-background px-1" />
							</label>
						</div>
					)}
					{panel === "sort" && (
						<div className="flex flex-col gap-1">
							{(view.sort ?? []).map((s, i) => (
								<div key={i} className="flex items-center gap-1">
									<select value={s.prop} onChange={(e) => setView({ sort: view.sort!.map((x, j) => (j === i ? { ...x, prop: e.target.value } : x)) })} className="rounded border bg-background px-1 py-0.5">
										{allProps.map((p) => (
											<option key={p}>{p}</option>
										))}
									</select>
									<select value={s.dir} onChange={(e) => setView({ sort: view.sort!.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)) })} className="rounded border bg-background px-1 py-0.5">
										<option value="asc">ascending</option>
										<option value="desc">descending</option>
									</select>
									<button type="button" onClick={() => setView({ sort: view.sort!.filter((_, j) => j !== i) })} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
										<XIcon className="size-3" />
									</button>
								</div>
							))}
							<button type="button" onClick={() => setView({ sort: [...(view.sort ?? []), { prop: "file.name", dir: "asc" }] })} className="w-fit rounded px-1 text-muted-foreground hover:bg-accent">
								+ Add sort
							</button>
						</div>
					)}
					{panel === "group" && (
						<div className="flex flex-col gap-2">
							<label className="flex items-center gap-2">
								Group by
								<select value={view.groupBy ?? ""} onChange={(e) => setView({ groupBy: e.target.value || undefined })} className="rounded border bg-background px-1 py-0.5">
									<option value="">{view.type === "kanban" ? "status (default)" : "none"}</option>
									{allProps.map((p) => (
										<option key={p}>{p}</option>
									))}
								</select>
							</label>
							{result.groups && (
								<div className="flex flex-col gap-0.5">
									<div className="text-muted-foreground">Order and visibility (Group menu)</div>
									{[...result.groups.map((g) => g.key), ...(view.hiddenGroups ?? [])].map((k, i, arr) => {
										const hidden = view.hiddenGroups?.includes(k);
										const order = arr.filter((x) => !view.hiddenGroups?.includes(x));
										return (
											<div key={k + i} className={cn("flex items-center gap-1", hidden && "opacity-50")}>
												<span className="w-40 truncate">{k || "(empty)"}</span>
												{!hidden && (
													<>
														<button type="button" disabled={i === 0} onClick={() => { const o = [...order]; [o[i - 1], o[i]] = [o[i]!, o[i - 1]!]; setView({ groupOrder: o }); }} className="rounded p-0.5 hover:bg-accent disabled:opacity-30">
															<ArrowUpIcon className="size-3" />
														</button>
														<button type="button" disabled={i >= order.length - 1} onClick={() => { const o = [...order]; [o[i + 1], o[i]] = [o[i]!, o[i + 1]!]; setView({ groupOrder: o }); }} className="rounded p-0.5 hover:bg-accent disabled:opacity-30">
															<ArrowDownIcon className="size-3" />
														</button>
													</>
												)}
												<button type="button" onClick={() => setView({ hiddenGroups: hidden ? view.hiddenGroups!.filter((x) => x !== k) : [...(view.hiddenGroups ?? []), k] })} className="rounded p-0.5 hover:bg-accent" title={hidden ? "Show" : "Hide"}>
													<EyeOffIcon className="size-3" />
												</button>
											</div>
										);
									})}
									{view.type === "kanban" && (
										<button
											type="button"
											className="w-fit rounded px-1 text-muted-foreground hover:bg-accent"
											onClick={() => {
												const k = prompt("New column (value of the group property)");
												if (k) setView({ groupOrder: [...(view.groupOrder ?? result.groups!.map((g) => g.key)), k] });
											}}
										>
											+ Add column
										</button>
									)}
								</div>
							)}
						</div>
					)}
					{panel === "formulas" && (
						<div className="flex flex-col gap-1">
							<div className="text-muted-foreground">
								Computed columns. Props by name, + − × ÷, comparisons, if(), days(), len(), lower(), upper(), concat(), round(), date(), now().
							</div>
							{Object.entries(config.formulas ?? {}).map(([name, expr]) => (
								<div key={name} className="flex items-center gap-1">
									<span className="w-28 truncate">{name}</span>
									<input defaultValue={expr} onBlur={(e) => onConfig({ ...config, formulas: { ...config.formulas, [name]: e.currentTarget.value } })} className="flex-1 rounded border bg-background px-1 py-0.5 font-mono" />
									<button type="button" onClick={() => { const f = { ...config.formulas }; delete f[name]; onConfig({ ...config, formulas: f, views: config.views.map((v) => ({ ...v, columns: v.columns.filter((c) => c !== `formula.${name}`) })) }); }} className="rounded p-0.5 text-muted-foreground hover:bg-accent">
										<XIcon className="size-3" />
									</button>
								</div>
							))}
							<button
								type="button"
								className="w-fit rounded px-1 text-muted-foreground hover:bg-accent"
								onClick={() => {
									const name = prompt("Formula name")?.trim().replace(/\W+/g, "_");
									if (name) onConfig({ ...config, formulas: { ...config.formulas, [name]: "file.words" }, views: config.views.map((v, i) => (i === viewIdx ? { ...v, columns: [...v.columns, `formula.${name}`] } : v)) });
								}}
							>
								+ Add formula
							</button>
						</div>
					)}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-auto">
				{result.total > result.rows.length && (
					<div className="border-b px-3 py-1 font-ui text-[11px] text-muted-foreground">
						Showing {result.rows.length} of {result.total} results (view limit).
					</div>
				)}
				{view.type === "table" &&
					(result.groups ?? [{ key: "", notes: result.rows }]).map((g) => (
						<div key={g.key}>
							{result.groups && <div className="sticky top-0 z-10 bg-background/95 px-3 py-1.5 font-ui text-xs font-medium">{g.key || "(empty)"} <span className="text-muted-foreground">{g.notes.length}</span></div>}
							<table className="lh-base-table w-full border-collapse text-sm">
								<thead>
									<tr>
										{view.columns.map((c) => (
											<th key={c} onClick={() => sortBy(c)} className="cursor-pointer select-none whitespace-nowrap border-b px-3 py-1.5 text-left font-ui text-[11px] font-normal uppercase tracking-wider text-muted-foreground hover:text-foreground">
												{label(c)}
												{view.sort?.[0]?.prop === c && (view.sort[0].dir === "asc" ? " ↑" : " ↓")}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{g.notes.map((n) => (
										<tr key={n.path} className="border-b border-border/50 hover:bg-accent/40">
											{view.columns.map((c) => {
												const v = Notes.propValue(n, c, ctx);
												const isEditing = editing?.path === n.path && editing.prop === c;
												return (
													<td
														key={c}
														className={cn("max-w-80 truncate px-3 py-1.5 align-top", c === "file.name" && "font-medium")}
														onClick={() => (c === "file.name" ? onOpen(n.path) : EDITABLE(c) ? setEditing({ path: n.path, prop: c }) : undefined)}
													>
														{isEditing ? cellEditor(n, c, v) : c === "file.name" ? <span className="lh-note-link cursor-pointer">{n.title}</span> : c === "file.tags" ? <TagList tags={n.tags} /> : typeof v === "boolean" ? <input type="checkbox" checked={v} onChange={(e) => onSetProp(n.path, c, e.target.checked)} onClick={(e) => e.stopPropagation()} /> : fmtCell(c, v)}
													</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					))}
				{view.type === "cards" && (
					<div className="flex flex-col gap-4 p-3">
						{(result.groups ?? [{ key: "", notes: result.rows }]).map((g) => (
							<div key={g.key}>
								{result.groups && <div className="mb-2 font-ui text-xs font-medium">{g.key || "(empty)"} <span className="text-muted-foreground">{g.notes.length}</span></div>}
								<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
									{g.notes.map((n) => (
										<Card key={n.path} n={n} view={view} ctx={ctx} onOpen={onOpen} index={index} />
									))}
								</div>
							</div>
						))}
					</div>
				)}
				{view.type === "kanban" && result.groups && (
					<div className="flex h-full gap-3 overflow-x-auto p-3">
						{result.groups.map((g) => (
							<div
								key={g.key}
								className={cn("flex w-64 shrink-0 flex-col rounded-lg border bg-card/50", dragPath && "outline-dashed outline-1 outline-border")}
								onDragOver={(e) => e.preventDefault()}
								onDrop={(e) => {
									e.preventDefault();
									const p = e.dataTransfer.getData("application/x-lh-card");
									if (p && groupKey) onSetProp(p, groupKey, g.key || null);
									setDragPath(null);
								}}
							>
								<div className="flex items-center justify-between px-3 py-2 font-ui text-xs font-medium">
									<span>{g.key || "(no " + groupKey + ")"}</span>
									<span className="text-muted-foreground">{g.notes.length}</span>
								</div>
								<div className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
									{g.notes.map((n) => (
										<div
											key={n.path}
											draggable
											onDragStart={(e) => {
												e.dataTransfer.setData("application/x-lh-card", n.path);
												setDragPath(n.path);
											}}
											onDragEnd={() => setDragPath(null)}
										>
											<Card n={n} view={view} ctx={ctx} onOpen={onOpen} index={index} hide={groupKey ? [groupKey] : []} />
										</div>
									))}
									{groupKey && EDITABLE(groupKey) && (
										<button type="button" onClick={() => onNewNote({ [groupKey]: g.key || null })} className="rounded-md px-2 py-1 text-left font-ui text-xs text-muted-foreground hover:bg-accent">
											+ New
										</button>
									)}
								</div>
							</div>
						))}
					</div>
				)}
				{result.rows.length === 0 && (
					<div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
						<div>No notes match this view.</div>
						<div className="font-ui text-xs">Adjust its filters, or add properties to notes (the ⋯ menu → Add property).</div>
					</div>
				)}
			</div>
		</div>
	);
}

function TagList({ tags }: { tags: string[] }) {
	return (
		<span className="flex flex-wrap gap-1">
			{tags.map((t) => (
				<span key={t} className="lh-note-tag">
					#{t}
				</span>
			))}
		</span>
	);
}

function Card({ n, view, ctx, onOpen, index, hide = [] }: { n: Notes.NoteMeta; view: Notes.BaseView; ctx: Notes.BaseContext; onOpen: (p: string) => void; index: Notes.VaultIndex; hide?: string[] }) {
	const cover = view.cover ? Notes.propToText(Notes.propValue(n, view.cover, ctx)).replace(/^!?\[\[|\]\]$/g, "") : "";
	const coverSrc = cover ? (/^https?:/.test(cover) ? cover : (() => {
		const r = new Notes.LinkResolver(index.files);
		const p = r.resolve(cover);
		return p ? Notes.rawHref(p) : "";
	})()) : "";
	return (
		<button type="button" onClick={() => onOpen(n.path)} className="flex w-full flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-colors hover:border-foreground/30">
			{coverSrc && (
				// eslint-disable-next-line @next/next/no-img-element
				<img src={coverSrc} alt="" className="h-28 w-full object-cover" />
			)}
			<div className="flex flex-col gap-1 p-2.5">
				<div className="text-sm font-medium">{n.title}</div>
				{view.columns
					.filter((c) => c !== "file.name" && !hide.includes(c))
					.map((c) => {
						const v = Notes.propValue(n, c, ctx);
						const s = c === "file.tags" ? n.tags.map((t) => "#" + t).join(" ") : fmtCell(c, v);
						if (!s) return null;
						return (
							<div key={c} className="truncate font-ui text-[11px] text-muted-foreground">
								<span className="opacity-70">{label(c)}:</span> {s}
							</div>
						);
					})}
			</div>
		</button>
	);
}
