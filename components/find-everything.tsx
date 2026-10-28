"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DumbbellIcon, FileIcon, FolderIcon, FolderInputIcon, MessageSquareIcon, NetworkIcon, SearchIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

/**
 * FIND EVERYTHING (fork, 2026-10-26) — one palette over sessions,
 * knowledge-graph propositions, and the files on your Desktop / Documents /
 * Downloads (GET /api/find). Opens on Mod+P in-app, and system-wide on
 * Ctrl/Cmd+Shift+Space in the desktop app (electron/main.cjs fires the
 * same lh:kbd-find-everything event after raising the window).
 *
 * Enter / click:
 *   session     → open it
 *   proposition → the graph, filtered to it (the graph's own search)
 *   file        → a new teaching session about that file (the agent reads it)
 *   folder      → a new teaching session over the folder (fork, 2026-10-27)
 * The dumbbell on a proposition starts a practice session on it; the import
 * button on a folder extracts all its text notes into the knowledge graph
 * (after a confirm — it spends model tokens). The desktop menu's "Learn a
 * Folder…" opens the palette on one chosen folder (lh:learn-folder).
 */

interface FindResults {
	sessions: Array<{ id: string; title: string; kind: string; updatedAt: string; snippet: string }>;
	propositions: Array<{ id: string; name: string; statement: string }>;
	files: Array<{ path: string; name: string; dir: string }>;
	roots: string[];
}

type Row =
	| { kind: "session"; key: string; data: FindResults["sessions"][number] }
	| { kind: "proposition"; key: string; data: FindResults["propositions"][number] }
	| { kind: "file"; key: string; data: FindResults["files"][number] };

function rowsOf(r: FindResults | null): Row[] {
	if (!r) return [];
	return [
		...r.sessions.map((d) => ({ kind: "session" as const, key: `s:${d.id}`, data: d })),
		...r.propositions.map((d) => ({ kind: "proposition" as const, key: `p:${d.id}`, data: d })),
		...r.files.map((d) => ({ kind: "file" as const, key: `f:${d.path}`, data: d })),
	];
}

const isFolder = (name: string) => name.endsWith("/") || name.endsWith("\\");

/** Confirm with the learner, then start extracting a folder's notes into the graph. */
export async function importFolderNotes(folder: string): Promise<void> {
	const preview = await fetch(`/api/graph/import-folder?path=${encodeURIComponent(folder)}`);
	const info = (await preview.json()) as { files?: string[]; skipped?: string[]; error?: string };
	if (!preview.ok || !info.files) {
		window.alert(info.error ?? "Couldn't read that folder.");
		return;
	}
	if (info.files.length === 0) {
		window.alert(`No text notes (.md, .txt, …) in ${folder}.`);
		return;
	}
	const extra = info.skipped?.length ? ` (${info.skipped.length} more skipped: too large or over the 200-file cap)` : "";
	const ok = window.confirm(
		`Import ${info.files.length} note file${info.files.length === 1 ? "" : "s"} from ${folder} into your knowledge graph${extra}?\n\n` +
			"Each file is read by your models, which uses tokens. Progress shows in the activity dock.",
	);
	if (!ok) return;
	const res = await fetch("/api/graph/import-folder", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: folder }),
	});
	const result = (await res.json()) as { ok: boolean; error?: string };
	if (!result.ok) window.alert(result.error ?? "Import failed to start.");
}

async function createSession(body: Record<string, unknown>): Promise<string> {
	const res = await fetch("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { id: string }).id;
}

export function FindEverything() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FindResults | null>(null);
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const close = useCallback(() => setOpen(false), []);
	const backdropDismiss = useBackdropDismiss(close);

	const [pinned, setPinned] = useState<FindResults | null>(null);

	useEffect(() => {
		const onOpen = () => {
			setPinned(null);
			setOpen(true);
			setTimeout(() => inputRef.current?.select(), 0);
		};
		// Desktop menu → Learn a Folder…: the palette shows just that folder.
		const onFolder = (e: Event) => {
			const folder = (e as CustomEvent<string>).detail;
			if (typeof folder !== "string" || !folder) return;
			const trimmed = folder.replace(/[\\/]+$/, "");
			const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
			const name = trimmed.slice(trimmed.lastIndexOf(sep) + 1) + sep;
			setQuery("");
			setPinned({ sessions: [], propositions: [], files: [{ path: trimmed, name, dir: trimmed.slice(0, trimmed.lastIndexOf(sep)) }], roots: [] });
			setActive(0);
			setOpen(true);
		};
		window.addEventListener("lh:kbd-find-everything", onOpen);
		window.addEventListener("lh:learn-folder", onFolder);
		return () => {
			window.removeEventListener("lh:kbd-find-everything", onOpen);
			window.removeEventListener("lh:learn-folder", onFolder);
		};
	}, []);

	// Debounced query.
	useEffect(() => {
		if (!open) return;
		const q = query.trim();
		if (!q) {
			setResults(null);
			return;
		}
		const ctrl = new AbortController();
		const t = setTimeout(() => {
			fetch(`/api/find?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
				.then((r) => r.json() as Promise<FindResults>)
				.then((r) => {
					setResults(r);
					setActive(0);
				})
				.catch(() => {});
		}, 150);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [query, open]);

	const rows = rowsOf(query.trim() ? results : (pinned ?? results));

	const choose = useCallback(
		async (row: Row, practice = false) => {
			setOpen(false);
			if (row.kind === "session") {
				router.push(`/chat/${row.data.id}`);
			} else if (row.kind === "proposition") {
				if (practice) {
					const title = `Practice: ${row.data.name}`;
					const id = await createSession({
						title,
						kind: "practice",
						graphContext: { propositions: [{ id: row.data.id, name: row.data.name, statement: row.data.statement }] },
					});
					router.push(`/chat/${id}?prompt=${encodeURIComponent(title)}`);
				} else {
					router.push(`/?find=${encodeURIComponent(row.data.name)}`);
					window.dispatchEvent(new CustomEvent("lh:graph-find", { detail: row.data.name }));
				}
			} else if (isFolder(row.data.name)) {
				const prompt =
					`Teach me the material in this folder: ${row.data.path}\n\n` +
					"Start by looking at what's in it, then suggest an order to learn it in.";
				const id = await createSession({ title: `Learn: ${row.data.name}` });
				router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
			} else {
				const prompt = `Teach me the material in this file: ${row.data.path}`;
				const id = await createSession({ title: `Learn: ${row.data.name}` });
				router.push(`/chat/${id}?prompt=${encodeURIComponent(prompt)}`);
			}
		},
		[router],
	);

	// Esc closes (document level — the one-Esc law: a surfaced layer claims
	// before the window-level fallback chain).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	if (!open) return null;

	const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(rows.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter" && rows[active]) {
			e.preventDefault();
			void choose(rows[active]!);
		}
	};

	const section = (label: string, kind: Row["kind"]) => {
		const items = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind === kind);
		if (items.length === 0) return null;
		return (
			<div className="py-1">
				<div className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
				{items.map(({ r, i }) => (
					<div
						key={r.key}
						data-active={i === active}
						onMouseEnter={() => setActive(i)}
						onClick={() => void choose(r)}
						className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm data-[active=true]:bg-accent"
					>
						<span className="mt-0.5 shrink-0 text-muted-foreground">
							{r.kind === "session" ? (
								r.data.kind === "practice" ? <DumbbellIcon className="size-4" /> : <MessageSquareIcon className="size-4" />
							) : r.kind === "proposition" ? (
								<NetworkIcon className="size-4" />
							) : isFolder(r.data.name) ? (
								<FolderIcon className="size-4" />
							) : (
								<FileIcon className="size-4" />
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-card-foreground">
								{r.kind === "session" ? r.data.title : r.kind === "proposition" ? r.data.name : r.data.name}
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{r.kind === "session" ? r.data.snippet || new Date(r.data.updatedAt).toLocaleDateString() : r.kind === "proposition" ? r.data.statement : r.data.dir}
							</span>
						</span>
						{r.kind === "proposition" ? (
							<button
								type="button"
								title="Practice this"
								onClick={(e) => {
									e.stopPropagation();
									void choose(r, true);
								}}
								className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
							>
								<DumbbellIcon className="size-3.5" />
							</button>
						) : r.kind === "file" && isFolder(r.data.name) ? (
							<button
								type="button"
								title="Import this folder's notes into the knowledge graph"
								data-testid="import-folder"
								onClick={(e) => {
									e.stopPropagation();
									setOpen(false);
									void importFolderNotes(r.data.path);
								}}
								className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
							>
								<FolderInputIcon className="size-3.5" />
							</button>
						) : null}
					</div>
				))}
			</div>
		);
	};

	return (
		<div data-testid="find-everything" className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" {...backdropDismiss}>
			<div className="w-full max-w-[40rem] overflow-hidden rounded-xl border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
				<div className="flex items-center gap-2 border-b px-3">
					<SearchIcon className="size-4 text-muted-foreground" />
					<input
						ref={inputRef}
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onInputKey}
						placeholder="Find sessions, ideas, and files…"
						className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div className="max-h-[60vh] overflow-y-auto">
					{query.trim() && results && rows.length === 0 ? (
						<div className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</div>
					) : null}
					{section("Sessions", "session")}
					{section("Knowledge graph", "proposition")}
					{section("Files", "file")}
				</div>
				<div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
					↑↓ walk · ↵ open · files and folders open as a new lesson
					{results?.roots.length ? ` · searching ${results.roots.join(", ")}` : ""}
				</div>
			</div>
		</div>
	);
}
