"use client";
/**
 * NOTES WORKSPACE (2026-11-06): Meander's Obsidian. A vault of plain
 * Markdown files with a file tree, tabs, Live Preview / Source / Reading
 * modes, properties, backlinks (+ unlinked mentions), outline, local and
 * global graph, Bases (table / cards / kanban), full-text search with
 * operators, tags, bookmarks, daily notes, templates, a quick switcher
 * (Mod-O) and command palette (Mod-P).
 *
 * Better than Obsidian, because it lives in a learning app: any note can
 * become a lesson ("Teach me this"), a practice session, or knowledge-graph
 * propositions in one click; changes from other devices reload live, and
 * edits that collide with a newer copy on disk are caught, never lost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
	BookmarkIcon,
	CalendarDaysIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	DatabaseIcon,
	DumbbellIcon,
	EyeIcon,
	FilePlusIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	GraduationCapIcon,
	HashIcon,
	ImageIcon,
	ListTreeIcon,
	Link2Icon,
	MoreHorizontalIcon,
	NetworkIcon,
	PanelLeftIcon,
	PanelRightIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	Settings2Icon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
	CodeIcon,
	WaypointsIcon,
	type LucideIcon,
} from "lucide-react";
import { Notes } from "@/src/core";
import { cn } from "@/lib/utils";
import { NoteEditor, type EditorHost, type NoteEditorHandle } from "./note-editor";
import { NoteReader } from "./note-reader";
import { NotesGraph } from "./notes-graph";
import { BaseView } from "./base-view";
import { ThemeToggle } from "@/components/theme";
import { SessionStarter } from "@/components/start-session";

// ─── Types / prefs ──────────────────────────────────────────────────────────

type Mode = "live" | "source" | "reading";
type TabKind = "note" | "base" | "graph" | "file";
interface Tab {
	id: string;
	kind: TabKind;
	path: string | null;
	text: string;
	saved: string;
	mtime: number;
	mode: Mode;
	loaded: boolean;
	conflict: { mtime: number } | null;
	nonce: number;
	scrollTo?: { line: number; nonce: number } | null;
}

interface Prefs {
	defaultOpen: "last" | "daily" | "new" | "specific";
	specificNote: string;
	dailyFolder: string;
	dailyFormat: string;
	templatesFolder: string;
	attachmentsFolder: string;
	newNoteFolder: string;
	defaultMode: Mode;
	readableWidth: boolean;
	spellcheck: boolean;
	confirmDelete: boolean;
}

const DEFAULT_PREFS: Prefs = {
	defaultOpen: "last",
	specificNote: "",
	dailyFolder: "Daily",
	dailyFormat: "YYYY-MM-DD",
	templatesFolder: "Templates",
	attachmentsFolder: "attachments",
	newNoteFolder: "",
	defaultMode: "live",
	readableWidth: true,
	spellcheck: true,
	confirmDelete: true,
};

const PREFS_KEY = "lh:notes-prefs";
const STATE_KEY = "lh:notes-state";
const BOOKMARKS_KEY = "lh:notes-bookmarks";

function load<T>(key: string, fallback: T): T {
	try {
		const v = localStorage.getItem(key);
		return v ? { ...fallback, ...JSON.parse(v) } : fallback;
	} catch {
		return fallback;
	}
}
function loadArr(key: string): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}
function save(key: string, v: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(v));
	} catch {
		/* private mode */
	}
}

let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

function kindOf(path: string): TabKind {
	if (Notes.isNotePath(path)) return "note";
	if (path.endsWith(Notes.BASE_EXT)) return "base";
	return "file";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body });
	return body;
}

function formatDate(fmt: string, d: Date): string {
	return Notes.fillTemplate(`{{date:${fmt}}}`, "", d);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function NotesApp() {
	const router = useRouter();
	const params = useSearchParams();
	const [index, setIndex] = useState<Notes.VaultIndex | null>(null);
	const [vault, setVault] = useState<{ root: string; custom: boolean; defaultRoot: string } | null>(null);
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
	const [bookmarks, setBookmarks] = useState<string[]>([]);
	const [recent, setRecent] = useState<string[]>([]);
	const [leftOpen, setLeftOpen] = useState(true);
	const [rightOpen, setRightOpen] = useState(true);
	const [leftTab, setLeftTab] = useState<"files" | "search" | "tags" | "bookmarks">("files");
	const [rightTab, setRightTab] = useState<"backlinks" | "outgoing" | "outline" | "graph">("backlinks");
	const [searchQ, setSearchQ] = useState("");
	const [modal, setModal] = useState<null | "switcher" | "palette" | "settings" | "template" | "move">(null);
	const [toast, setToast] = useState<string | null>(null);
	const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
	const [cursorLine, setCursorLine] = useState(0);
	const [menu, setMenu] = useState<{ x: number; y: number; items: { label: string; icon?: LucideIcon; run: () => void; danger?: boolean }[] } | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [narrow, setNarrow] = useState(false);
	const editorHandle = useRef<NoteEditorHandle | null>(null);
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const indexRef = useRef(index);
	indexRef.current = index;
	const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const textCache = useRef(new Map<string, string>());
	const starter = useRef(new SessionStarter());
	const booted = useRef(false);

	const active = tabs.find((t) => t.id === activeId) ?? null;
	const activeMeta = active?.path ? index?.notes.find((n) => n.path === active.path) ?? null : null;

	const flash = useCallback((msg: string) => {
		setToast(msg);
		setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
	}, []);

	// ── Index loading + live refresh (other devices, other apps) ──
	const refresh = useCallback(async () => {
		try {
			const r = await api<{ index: Notes.VaultIndex; vault: { root: string; custom: boolean; defaultRoot: string } }>("/api/notes");
			setIndex(r.index);
			setVault(r.vault);
			return r.index;
		} catch (err) {
			flash(`Couldn't read the vault: ${(err as Error).message}`);
			return null;
		}
	}, [flash]);

	useEffect(() => {
		setPrefs(load(PREFS_KEY, DEFAULT_PREFS));
		setBookmarks(loadArr(BOOKMARKS_KEY));
		const mq = matchMedia("(max-width: 900px)");
		const on = () => {
			setNarrow(mq.matches);
			if (mq.matches) {
				setLeftOpen(false);
				setRightOpen(false);
			}
		};
		on();
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);

	useEffect(() => {
		void refresh();
		const id = setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 5000);
		const onVis = () => document.visibilityState === "visible" && void refresh();
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [refresh]);

	const resolver = useMemo(() => (index ? new Notes.LinkResolver(index.files, index.notes) : null), [index]);

	// Reload clean tabs whose file changed on disk.
	useEffect(() => {
		if (!index) return;
		for (const t of tabsRef.current) {
			if (!t.path || !t.loaded || t.kind === "graph" || t.kind === "file") continue;
			const f = index.files.find((x) => x.path === t.path);
			if (!f) continue;
			if (Math.abs(f.mtime - t.mtime) > 1 && t.text === t.saved) void loadTab(t.id, t.path, true);
		}
	}, [index]);

	// ── Tabs ──
	const loadTab = useCallback(async (id: string, path: string, reload = false) => {
		try {
			const r = await api<{ content: string; mtime: number }>(`/api/notes/file?path=${encodeURIComponent(path)}`);
			textCache.current.set(path, r.content);
			setTabs((ts) =>
				ts.map((t) =>
					t.id === id
						? { ...t, text: r.content, saved: r.content, mtime: r.mtime, loaded: true, conflict: null, nonce: reload ? t.nonce + 1 : t.nonce }
						: t,
				),
			);
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				setTabs((ts) => ts.filter((t) => t.id !== id));
				flash(`${Notes.basename(path)} no longer exists.`);
			}
		}
	}, [flash]);

	const pushRecent = useCallback((path: string) => {
		setRecent((r) => {
			const next = [path, ...r.filter((x) => x !== path)].slice(0, 30);
			return next;
		});
	}, []);

	const open = useCallback(
		(path: string, opts: { newTab?: boolean; sub?: string | null } = {}) => {
			const kind = kindOf(path);
			const existing = tabsRef.current.find((t) => t.path === path);
			pushRecent(path);
			if (narrow) setLeftOpen(false);
			const scrollFor = (text: string) => {
				if (!opts.sub) return null;
				const sub = opts.sub.startsWith("^") ? { block: opts.sub.slice(1) } : { heading: opts.sub };
				if (sub.heading) {
					const h = Notes.extractHeadings(text).find((x) => Notes.slugHeading(x.text) === Notes.slugHeading(sub.heading!));
					return h ? { line: h.line, nonce: Date.now() } : null;
				}
				const b = Notes.extractBlockIds(text).find((x) => x.id === sub.block);
				return b ? { line: b.line, nonce: Date.now() } : null;
			};
			if (existing) {
				setActiveId(existing.id);
				if (opts.sub) setTabs((ts) => ts.map((t) => (t.id === existing.id ? { ...t, scrollTo: scrollFor(t.text) } : t)));
				return;
			}
			const tab: Tab = { id: newTabId(), kind, path, text: "", saved: "", mtime: 0, mode: prefs.defaultMode, loaded: kind === "file", conflict: null, nonce: 0 };
			setTabs((ts) => {
				const cur = ts.findIndex((t) => t.id === activeId);
				const replace = !opts.newTab && cur >= 0 && ts[cur]!.text === ts[cur]!.saved && ts[cur]!.kind !== "graph";
				if (replace) return ts.map((t, i) => (i === cur ? tab : t));
				return [...ts.slice(0, cur + 1), tab, ...ts.slice(cur + 1)];
			});
			setActiveId(tab.id);
			if (kind !== "file") {
				void loadTab(tab.id, path).then(() => {
					if (opts.sub) setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, scrollTo: scrollFor(t.text) } : t)));
				});
			}
		},
		[activeId, loadTab, narrow, prefs.defaultMode, pushRecent],
	);

	const openGraph = useCallback(() => {
		const existing = tabsRef.current.find((t) => t.kind === "graph");
		if (existing) return setActiveId(existing.id);
		const tab: Tab = { id: newTabId(), kind: "graph", path: null, text: "", saved: "", mtime: 0, mode: "live", loaded: true, conflict: null, nonce: 0 };
		setTabs((ts) => [...ts, tab]);
		setActiveId(tab.id);
	}, []);

	const flushSave = useCallback(async (id: string) => {
		const t = tabsRef.current.find((x) => x.id === id);
		if (!t || !t.path || t.text === t.saved || t.conflict) return;
		const text = t.text;
		try {
			const r = await api<{ mtime: number }>("/api/notes/file", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: t.path, content: text, baseMtime: t.mtime }),
			});
			textCache.current.set(t.path, text);
			setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, saved: text, mtime: r.mtime } : x)));
		} catch (err) {
			const e = err as { status?: number; body?: { mtime?: number } };
			if (e.status === 409) setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, conflict: { mtime: e.body?.mtime ?? 0 } } : x)));
			else flash(`Save failed: ${(err as Error).message}`);
		}
	}, [flash]);

	const setText = useCallback(
		(id: string, text: string) => {
			setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, text } : t)));
			const timers = saveTimers.current;
			clearTimeout(timers.get(id));
			timers.set(id, setTimeout(() => void flushSave(id), 600));
		},
		[flushSave],
	);

	// Save everything before leaving.
	useEffect(() => {
		const onUnload = (e: BeforeUnloadEvent) => {
			if (tabsRef.current.some((t) => t.text !== t.saved && !t.conflict)) {
				for (const t of tabsRef.current) void flushSave(t.id);
				e.preventDefault();
			}
		};
		window.addEventListener("beforeunload", onUnload);
		return () => {
			window.removeEventListener("beforeunload", onUnload);
			for (const t of tabsRef.current) void flushSave(t.id);
		};
	}, [flushSave]);

	const closeTab = useCallback(
		(id: string) => {
			void flushSave(id);
			setTabs((ts) => {
				const i = ts.findIndex((t) => t.id === id);
				const next = ts.filter((t) => t.id !== id);
				if (id === activeId) setActiveId(next[Math.min(i, next.length - 1)]?.id ?? null);
				return next;
			});
		},
		[activeId, flushSave],
	);

	// ── File operations ──
	const uniquePath = useCallback((folder: string, stem: string, ext: string) => {
		const files = new Set((indexRef.current?.files ?? []).map((f) => f.path.toLowerCase()));
		const base = folder ? `${folder}/` : "";
		let p = `${base}${stem}${ext}`;
		for (let i = 1; files.has(p.toLowerCase()); i++) p = `${base}${stem} ${i}${ext}`;
		return p;
	}, []);

	const createNote = useCallback(
		async (opts: { folder?: string; title?: string; content?: string; open?: boolean; newTab?: boolean } = {}) => {
			const folder = opts.folder ?? (active?.path ? Notes.dirname(active.path) : prefs.newNoteFolder);
			const title = (opts.title ?? "Untitled").replace(Notes.ILLEGAL_NAME_CHARS, " ").trim() || "Untitled";
			const path = opts.title && !opts.folder && opts.title.includes("/") ? `${opts.title.replace(/\.md$/, "")}.md` : uniquePath(folder, title, ".md");
			try {
				await api("/api/notes/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: opts.content ?? "" }) });
			} catch (err) {
				if ((err as { status?: number }).status !== 409) {
					flash((err as Error).message);
					return null;
				}
			}
			await refresh();
			if (opts.open !== false) {
				open(path, { newTab: opts.newTab });
				if (!opts.title) setRenaming(path);
			}
			return path;
		},
		[active?.path, flash, open, prefs.newNoteFolder, refresh, uniquePath],
	);

	const createBase = useCallback(async () => {
		const folder = active?.path ? Notes.dirname(active.path) : "";
		const path = uniquePath(folder, "Untitled", ".base");
		await api("/api/notes/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: Notes.stringifyBase(Notes.defaultBase()) }) });
		await refresh();
		open(path);
	}, [active?.path, open, refresh, uniquePath]);

	const createFolder = useCallback(
		async (parent = "") => {
			const name = prompt("Folder name");
			if (!name) return;
			const path = parent ? `${parent}/${name}` : name;
			try {
				await api("/api/notes/folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
				await refresh();
			} catch (err) {
				flash((err as Error).message);
			}
		},
		[flash, refresh],
	);

	const rename = useCallback(
		async (from: string, to: string) => {
			if (!to || from === to) return;
			for (const t of tabsRef.current) if (t.path === from) await flushSave(t.id);
			try {
				const r = await api<{ updated: string[] }>("/api/notes/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }) });
				setTabs((ts) =>
					ts.map((t) => {
						if (t.path === from) return { ...t, path: to };
						if (t.path?.startsWith(from + "/")) return { ...t, path: to + t.path.slice(from.length) };
						return t;
					}),
				);
				setBookmarks((b) => {
					const next = b.map((x) => (x === from ? to : x.startsWith(from + "/") ? to + x.slice(from.length) : x));
					save(BOOKMARKS_KEY, next);
					return next;
				});
				const idx = await refresh();
				// Notes whose links were rewritten: reload open copies.
				for (const t of tabsRef.current) if (t.path && r.updated.includes(t.path)) void loadTab(t.id, t.path, true);
				if (r.updated.length) flash(`Updated links in ${r.updated.length} note${r.updated.length === 1 ? "" : "s"}.`);
				void idx;
			} catch (err) {
				flash((err as Error).message);
			}
		},
		[flash, flushSave, loadTab, refresh],
	);

	const remove = useCallback(
		async (path: string) => {
			let attachments = false;
			if (Notes.isNotePath(path)) {
				const r = await api<{ attachments: string[] }>(`/api/notes/file?path=${encodeURIComponent(path)}&orphans=1`).catch(() => ({ attachments: [] as string[] }));
				if (prefs.confirmDelete && !confirm(`Move "${Notes.noteTitle(path)}" to the vault trash?`)) return;
				if (r.attachments.length) attachments = confirm(`Also delete ${r.attachments.length} attachment${r.attachments.length === 1 ? "" : "s"} only this note uses?\n\n${r.attachments.join("\n")}`);
			} else if (prefs.confirmDelete && !confirm(`Move "${Notes.basename(path)}" to the vault trash?`)) return;
			await api(`/api/notes/file?path=${encodeURIComponent(path)}${attachments ? "&attachments=1" : ""}`, { method: "DELETE" });
			setTabs((ts) => ts.filter((t) => t.path !== path && !t.path?.startsWith(path + "/")));
			await refresh();
		},
		[prefs.confirmDelete, refresh],
	);

	const upload = useCallback(
		async (files: File[]) => {
			const fd = new FormData();
			for (const f of files) {
				const name = f.name && f.name !== "image.png" ? f.name : `Pasted image ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
				fd.append("files", new File([f], name, { type: f.type }));
			}
			fd.append("folder", prefs.attachmentsFolder || "attachments");
			try {
				const r = await api<{ paths: string[] }>("/api/notes/upload", { method: "POST", body: fd });
				await refresh();
				return r.paths;
			} catch (err) {
				flash((err as Error).message);
				return [];
			}
		},
		[flash, prefs.attachmentsFolder, refresh],
	);

	// ── Daily notes, templates ──
	const templates = useMemo(() => (index?.notes ?? []).filter((n) => prefs.templatesFolder && (n.folder === prefs.templatesFolder || n.folder.startsWith(prefs.templatesFolder + "/"))), [index, prefs.templatesFolder]);

	const openDaily = useCallback(
		async (date = new Date()) => {
			const name = formatDate(prefs.dailyFormat || "YYYY-MM-DD", date);
			const path = `${prefs.dailyFolder ? prefs.dailyFolder + "/" : ""}${name}.md`;
			if (!indexRef.current?.files.some((f) => f.path === path)) {
				const tpl = indexRef.current?.notes.find((n) => n.path === `${prefs.templatesFolder}/Daily.md` || n.path === `${prefs.templatesFolder}/Daily note.md`);
				let content = `# ${name}\n\n`;
				if (tpl) {
					const r = await api<{ content: string }>(`/api/notes/file?path=${encodeURIComponent(tpl.path)}`).catch(() => null);
					if (r) content = Notes.fillTemplate(r.content, name, date);
				}
				await api("/api/notes/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }) }).catch(() => null);
				await refresh();
			}
			open(path);
		},
		[open, prefs.dailyFolder, prefs.dailyFormat, prefs.templatesFolder, refresh],
	);

	const insertText = useCallback((text: string) => {
		const view = editorHandle.current?.view;
		if (!view) return false;
		const r = view.state.selection.main;
		view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
		view.focus();
		return true;
	}, []);

	const applyTemplate = useCallback(
		async (tplPath: string) => {
			const r = await api<{ content: string }>(`/api/notes/file?path=${encodeURIComponent(tplPath)}`);
			const filled = Notes.fillTemplate(r.content, active?.path ? Notes.noteTitle(active.path) : "", new Date());
			const fm = Notes.parseFrontmatter(filled);
			if (active && fm.present && Object.keys(fm.props).length) {
				const cur = Notes.parseFrontmatter(active.text);
				const merged = Notes.withProps(active.text, { ...fm.props, ...cur.props });
				setText(active.id, merged);
				setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, nonce: t.nonce + 1 } : t)));
				setTimeout(() => insertText(fm.body), 50);
			} else if (!insertText(filled)) flash("Open a note in edit mode first.");
		},
		[active, flash, insertText, setText],
	);

	// ── AI actions (the part Obsidian can't do) ──
	const teach = useCallback(
		async (kind: "teach" | "practice") => {
			if (!active?.path || !Notes.isNotePath(active.path)) return;
			await flushSave(active.id);
			const title = Notes.noteTitle(active.path);
			const body = Notes.parseFrontmatter(active.text).body.trim().slice(0, 24000);
			const prompt =
				kind === "teach"
					? `Teach me what's in my note "${title}". Check what I already know first, then go through it properly.\n\n---\n${body}`
					: `Give me practice problems on my note "${title}".\n\n---\n${body}`;
			try {
				const href = await starter.current.start({ title: prompt, ...(kind === "practice" ? { kind: "practice" as const } : {}) }, fetch);
				router.push(href);
			} catch (err) {
				flash((err as Error).message);
			}
		},
		[active, flash, flushSave, router],
	);

	const addToGraph = useCallback(async () => {
		if (!active?.path) return;
		await flushSave(active.id);
		const fd = new FormData();
		fd.append("files", new File([active.text], Notes.basename(active.path), { type: "text/markdown" }));
		fd.append("paths", `notes/${active.path}`);
		flash("Extracting into your knowledge graph… (progress in the activity dock)");
		try {
			const r = await api<{ results: { ok: boolean; error?: string; stats?: { nodes?: number } }[] }>("/api/graph/import", { method: "POST", body: fd });
			const first = r.results?.[0];
			flash(first?.ok ? "Added to your knowledge graph." : `Graph import: ${first?.error ?? "failed"}`);
		} catch (err) {
			flash(`Graph import: ${(err as Error).message}`);
		}
	}, [active, flash, flushSave]);

	// ── Properties ──
	const setProps = useCallback(
		(props: Notes.Props) => {
			if (!active) return;
			setText(active.id, Notes.withProps(active.text, props));
		},
		[active, setText],
	);

	const setPropOn = useCallback(
		async (path: string, prop: string, value: Notes.PropValue) => {
			const open = tabsRef.current.find((t) => t.path === path);
			if (open) {
				const props = { ...Notes.parseFrontmatter(open.text).props, [prop]: value };
				if (value === null) delete props[prop];
				setText(open.id, Notes.withProps(open.text, props));
				setTabs((ts) => ts.map((t) => (t.id === open.id ? { ...t, nonce: t.nonce + 1 } : t)));
				setTimeout(() => void flushSave(open.id).then(refresh), 700);
				return;
			}
			const r = await api<{ content: string; mtime: number }>(`/api/notes/file?path=${encodeURIComponent(path)}`);
			const props = { ...Notes.parseFrontmatter(r.content).props, [prop]: value };
			if (value === null) delete props[prop];
			await api("/api/notes/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content: Notes.withProps(r.content, props), baseMtime: r.mtime }) });
			await refresh();
		},
		[flushSave, refresh, setText],
	);

	// ── Boot: ?open / ?tag / ?create, then the default file (1.11) ──
	useEffect(() => {
		if (!index || booted.current) return;
		booted.current = true;
		const p = params.get("open");
		const tag = params.get("tag");
		const create = params.get("create");
		const st = load<{ tabs: string[]; active: string | null; recent: string[] }>(STATE_KEY, { tabs: [], active: null, recent: [] });
		setRecent(st.recent ?? []);
		if (p) return open(p);
		if (tag) {
			setLeftTab("search");
			setSearchQ(`tag:#${tag}`);
			return;
		}
		if (create) {
			void createNote({ title: create, folder: prefs.newNoteFolder });
			return;
		}
		const pf = load(PREFS_KEY, DEFAULT_PREFS);
		const exists = (x: string) => index.files.some((f) => f.path === x);
		if (pf.defaultOpen === "daily") return void openDaily();
		if (pf.defaultOpen === "new") return void createNote({});
		if (pf.defaultOpen === "specific" && pf.specificNote && exists(pf.specificNote)) return open(pf.specificNote);
		const restore = (st.tabs ?? []).filter(exists);
		if (restore.length) {
			for (const t of restore) open(t, { newTab: true });
			if (st.active && exists(st.active)) setTimeout(() => open(st.active!), 0);
		} else if (index.notes.length === 0) void seedWelcome();
		else open([...index.notes].sort((a, b) => b.mtime - a.mtime)[0]!.path);
	}, [index]);

	// Navigations inside the page (/notes?open=… from links elsewhere).
	useEffect(() => {
		if (!booted.current) return;
		const p = params.get("open");
		if (p) open(p);
		const tag = params.get("tag");
		if (tag) {
			setLeftOpen(true);
			setLeftTab("search");
			setSearchQ(`tag:#${tag}`);
		}
	}, [params]);

	useEffect(() => {
		if (!booted.current) return;
		save(STATE_KEY, { tabs: tabs.filter((t) => t.path).map((t) => t.path), active: active?.path ?? null, recent });
	}, [tabs, active?.path, recent]);

	const seedWelcome = useCallback(async () => {
		const welcome = `---
tags: [meander]
status: doing
---
# Welcome to your notes

Plain Markdown files in your Meander data folder (or any folder you choose in ⚙ settings — an existing Obsidian vault works as-is).

- [[Second note]] — type \`[[\` to link a note, \`#\` to tag it.
- **Live Preview** hides the Markdown while you write; ⌘E flips to Reading.
- ⌘O quick switcher · ⌘P commands · ⌘⇧F search · ⌘⇧D today's note.
- ⋯ → **Teach me this** turns a note into a lesson, **Practice** into problems, **Add to knowledge graph** into propositions.

> [!tip] Bases
> New base (the database icon) makes table, card and kanban views over note properties like \`status\`.

- [ ] Try checking this box
- [x] Open the graph view (network icon)

==Highlights== and =={blue}colored highlights==, $e^{i\\pi}+1=0$, and mermaid:

\`\`\`mermaid
graph LR; Note-->Lesson; Note-->Practice; Note-->Graph
\`\`\`
`;
		await api("/api/notes/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "Welcome.md", content: welcome }) }).catch(() => null);
		await api("/api/notes/file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "Second note.md", content: "---\nstatus: todo\n---\nLinks back to [[Welcome]]. #meander\n" }) }).catch(() => null);
		await refresh();
		open("Welcome.md");
	}, [open, refresh]);

	// ── Commands ──
	const commands = useMemo(
		() =>
			[
				{ id: "new", label: "New note", hint: "⌘N", run: () => void createNote({}) },
				{ id: "new-tab", label: "New note in new tab", run: () => void createNote({ newTab: true }) },
				{ id: "new-base", label: "New base", run: () => void createBase() },
				{ id: "new-folder", label: "New folder", run: () => void createFolder(active?.path ? Notes.dirname(active.path) : "") },
				{ id: "daily", label: "Open today's daily note", hint: "⌘⇧D", run: () => void openDaily() },
				{ id: "yesterday", label: "Open yesterday's daily note", run: () => void openDaily(new Date(Date.now() - 86_400_000)) },
				{ id: "switcher", label: "Quick switcher", hint: "⌘O", run: () => setModal("switcher") },
				{ id: "search", label: "Search all notes", hint: "⌘⇧F", run: () => { setLeftOpen(true); setLeftTab("search"); } },
				{ id: "graph", label: "Open graph view", hint: "⌘G", run: openGraph },
				{ id: "mode", label: "Toggle reading / editing", hint: "⌘E", run: () => active && setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, mode: t.mode === "reading" ? prefs.defaultMode === "reading" ? "live" : prefs.defaultMode : "reading" } : t))) },
				{ id: "source", label: "Toggle Live Preview / Source mode", run: () => active && setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, mode: t.mode === "source" ? "live" : "source", nonce: t.nonce + 1 } : t))) },
				{ id: "template", label: "Insert template", run: () => setModal("template") },
				{ id: "teach", label: "Teach me this note", run: () => void teach("teach") },
				{ id: "practice", label: "Practice this note", run: () => void teach("practice") },
				{ id: "graph-import", label: "Add this note to the knowledge graph", run: () => void addToGraph() },
				{ id: "rename", label: "Rename note", hint: "F2", run: () => active?.path && setRenaming(active.path) },
				{ id: "move", label: "Move note to folder…", run: () => active?.path && setModal("move") },
				{ id: "delete", label: "Delete note", run: () => active?.path && void remove(active.path) },
				{ id: "bookmark", label: "Bookmark / unbookmark note", run: () => active?.path && toggleBookmark(active.path) },
				{ id: "copy-link", label: "Copy wikilink to note", run: () => active?.path && resolver && void navigator.clipboard?.writeText(`[[${resolver.linkText(active.path)}]]`).then(() => flash("Link copied.")) },
				{ id: "left", label: "Toggle left sidebar", run: () => setLeftOpen((v) => !v) },
				{ id: "right", label: "Toggle right sidebar", run: () => setRightOpen((v) => !v) },
				{ id: "settings", label: "Notes settings", run: () => setModal("settings") },
				{ id: "close", label: "Close tab", hint: "⌘W", run: () => active && closeTab(active.id) },
			] as { id: string; label: string; hint?: string; run: () => void }[],
		[active, createNote, createBase, createFolder, openDaily, openGraph, prefs.defaultMode, teach, addToGraph, remove, resolver, closeTab, flash],
	);

	const toggleBookmark = useCallback((path: string) => {
		setBookmarks((b) => {
			const next = b.includes(path) ? b.filter((x) => x !== path) : [...b, path];
			save(BOOKMARKS_KEY, next);
			return next;
		});
	}, []);

	// ── Keyboard (document level: fires before the app's window registry,
	//    so the notes page owns ⌘O/⌘P/⌘N/⌘E/⌘W/⌘G while it's mounted) ──
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			const inEditor = !!(e.target as HTMLElement | null)?.closest?.("[data-lh-notes-keys]");
			const claim = () => {
				e.preventDefault();
				e.stopPropagation();
			};
			if (modal && e.key === "Escape") {
				claim();
				setModal(null);
				return;
			}
			if (lightbox && e.key === "Escape") {
				claim();
				setLightbox(null);
				return;
			}
			if (menu && e.key === "Escape") {
				claim();
				setMenu(null);
				return;
			}
			if (mod && !e.altKey) {
				const k = e.key.toLowerCase();
				if (k === "o") return claim(), setModal("switcher");
				if (k === "p") return claim(), setModal("palette");
				if (k === "n" && !e.shiftKey) return claim(), void createNote({});
				if (k === "e" && !inEditor) return claim(), commands.find((c) => c.id === "mode")!.run();
				if (k === "e" && inEditor && active?.mode !== "reading" && e.shiftKey) return claim(), commands.find((c) => c.id === "mode")!.run();
				if (k === "w") return claim(), active && closeTab(active.id);
				if (k === "g") return claim(), openGraph();
				if (k === "d" && e.shiftKey) return claim(), void openDaily();
				if (k === "f" && e.shiftKey) return claim(), (setLeftOpen(true), setLeftTab("search"), setTimeout(() => document.querySelector<HTMLInputElement>("[data-notes-search]")?.focus(), 30));
				if (k === "s") return claim(), active && void flushSave(active.id);
				if (k === "\\") return claim(), setRightOpen((v) => !v);
			}
			if (e.key === "F2" && active?.path) return claim(), setRenaming(active.path);
			// Keys the editor handled (formatting, Tab) must not reach the
			// app's global shortcuts (⌘B sidebar, Tab field cycling).
			if (inEditor && (e.defaultPrevented || e.key === "Tab" || (mod && ["b", "i", "k", "f", "l", "d"].includes(e.key.toLowerCase())))) e.stopPropagation();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [active, closeTab, commands, createNote, flushSave, lightbox, menu, modal, openDaily, openGraph]);

	useEffect(() => {
		const onBox = (e: Event) => setLightbox((e as CustomEvent<{ src: string; alt: string }>).detail);
		window.addEventListener("lh:notes-lightbox", onBox);
		return () => window.removeEventListener("lh:notes-lightbox", onBox);
	}, []);

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		window.addEventListener("pointerdown", close);
		return () => window.removeEventListener("pointerdown", close);
	}, [menu]);

	// ── Editor host ──
	const host: EditorHost = useMemo(
		() => ({
			resolve: (t) => resolver?.resolve(t, active?.path ?? undefined) ?? null,
			rawHref: Notes.rawHref,
			isImage: Notes.isImagePath,
			noteOptions: () => {
				const out: { label: string; detail?: string; path: string }[] = [];
				for (const n of indexRef.current?.notes ?? []) {
					out.push({ label: n.title, detail: n.folder || undefined, path: n.path });
					for (const a of n.aliases) out.push({ label: a, detail: `→ ${n.title}`, path: n.path });
				}
				for (const f of indexRef.current?.files ?? []) if (!Notes.isNotePath(f.path)) out.push({ label: Notes.basename(f.path), detail: Notes.dirname(f.path) || undefined, path: f.path });
				return out;
			},
			headingsOf: (p) => indexRef.current?.notes.find((n) => n.path === p)?.headings.map((h) => h.text) ?? [],
			tagOptions: () => Object.values(indexRef.current?.tags ?? {}).sort((a, b) => b.count - a.count),
			openLink: (target, newTab) => {
				const [t, sub] = target.split("#");
				const p = t ? resolver?.resolve(t, active?.path ?? undefined) : active?.path;
				if (p) open(p, { newTab, sub: sub ?? null });
				else if (t) void createNote({ title: t, folder: prefs.newNoteFolder, newTab });
			},
			openTag: (tag) => {
				setLeftOpen(true);
				setLeftTab("search");
				setSearchQ(`tag:#${tag}`);
			},
			upload,
			linkText: (p) => resolver?.linkText(p) ?? Notes.noteTitle(p),
		}),
		[resolver, active?.path, open, createNote, prefs.newNoteFolder, upload],
	);

	const readNote = useCallback((p: string) => {
		const t = tabsRef.current.find((x) => x.path === p);
		if (t?.loaded) return t.text;
		const cached = textCache.current.get(p);
		if (cached !== undefined) return cached;
		void fetch(`/api/notes/file?path=${encodeURIComponent(p)}`)
			.then((r) => r.json())
			.then((b: { content?: string }) => {
				if (typeof b.content === "string") {
					textCache.current.set(p, b.content);
					setTabs((ts) => [...ts]);
				}
			});
		return null;
	}, []);
	const resolveForReading = useCallback((t: string) => resolver?.resolve(t, active?.path ?? undefined) ?? null, [resolver, active?.path]);

	// ── Render ──
	if (!index) {
		return <div className="flex h-dvh items-center justify-center font-ui text-xs text-muted-foreground">Opening vault…</div>;
	}

	const fm = active?.kind === "note" ? Notes.parseFrontmatter(active.text) : null;
	const fmLines = fm?.present ? active!.text.slice(0, fm.bodyStart).split("\n").length - 1 : 0;
	const editorDoc = active?.kind === "note" ? (active.mode === "source" ? active.text : fm!.body) : "";

	return (
		<div className="lh-notes relative flex h-dvh min-w-0 flex-col bg-background" data-testid="notes-app">
			{/* Top bar */}
			<div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 font-ui text-xs">
				<IconBtn icon={PanelLeftIcon} label="Toggle left sidebar" onClick={() => setLeftOpen((v) => !v)} />
				<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
					{tabs.map((t) => (
						<div
							key={t.id}
							className={cn("group flex max-w-48 shrink-0 items-center gap-1 rounded-md px-2 py-1", t.id === activeId ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50")}
							onMouseDown={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									closeTab(t.id);
								}
							}}
						>
							<button type="button" className="flex min-w-0 items-center gap-1" onClick={() => setActiveId(t.id)}>
								{t.kind === "graph" ? <NetworkIcon className="size-3 shrink-0" /> : t.kind === "base" ? <DatabaseIcon className="size-3 shrink-0" /> : t.kind === "file" ? <ImageIcon className="size-3 shrink-0" /> : <FileTextIcon className="size-3 shrink-0" />}
								<span className="truncate">{t.kind === "graph" ? "Graph" : t.path ? Notes.noteTitle(t.path) : "…"}</span>
								{t.text !== t.saved && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" title="Unsaved" />}
							</button>
							<button type="button" aria-label="Close tab" className="rounded opacity-0 hover:bg-background/60 group-hover:opacity-100" onClick={() => closeTab(t.id)}>
								<XIcon className="size-3" />
							</button>
						</div>
					))}
					<IconBtn icon={PlusIcon} label="New note (⌘N)" onClick={() => void createNote({ newTab: true })} />
				</div>
				<IconBtn icon={SearchIcon} label="Quick switcher (⌘O)" onClick={() => setModal("switcher")} />
				<IconBtn icon={NetworkIcon} label="Graph view (⌘G)" onClick={openGraph} />
				<ThemeToggle />
				<IconBtn icon={PanelRightIcon} label="Toggle right sidebar (⌘\)" onClick={() => setRightOpen((v) => !v)} />
			</div>

			<div className="relative flex min-h-0 flex-1">
				{/* Left sidebar */}
				{leftOpen && (
					<aside className={cn("flex w-64 shrink-0 flex-col border-r bg-card/40", narrow && "absolute inset-y-0 left-0 z-30 w-[85vw] max-w-80 bg-background shadow-2xl")} data-testid="notes-left">
						<div className="flex items-center gap-0.5 border-b px-2 py-1.5">
							{([["files", FolderIcon, "Files"], ["search", SearchIcon, "Search"], ["tags", HashIcon, "Tags"], ["bookmarks", BookmarkIcon, "Bookmarks"]] as const).map(([k, Icon, lbl]) => (
								<IconBtn key={k} icon={Icon} label={lbl} active={leftTab === k} onClick={() => setLeftTab(k)} />
							))}
							<div className="ml-auto flex items-center">
								<IconBtn icon={FilePlusIcon} label="New note" onClick={() => void createNote({ folder: prefs.newNoteFolder })} />
								<IconBtn icon={FolderPlusIcon} label="New folder" onClick={() => void createFolder()} />
								<IconBtn icon={DatabaseIcon} label="New base" onClick={() => void createBase()} />
								<IconBtn icon={CalendarDaysIcon} label="Today's note (⌘⇧D)" onClick={() => void openDaily()} />
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto py-1">
							{leftTab === "files" && (
								<FileTree
									index={index}
									activePath={active?.path ?? null}
									renaming={renaming}
									onRenameDone={(from, to) => {
										setRenaming(null);
										if (to) void rename(from, to);
									}}
									onOpen={(p, newTab) => open(p, { newTab })}
									onMove={(from, toFolder) => void rename(from, toFolder ? `${toFolder}/${Notes.basename(from)}` : Notes.basename(from))}
									onContext={(e, path, isFolder) => {
										e.preventDefault();
										const items = isFolder
											? [
													{ label: "New note here", icon: FilePlusIcon, run: () => void createNote({ folder: path }) },
													{ label: "New folder here", icon: FolderPlusIcon, run: () => void createFolder(path) },
													{ label: "Rename", icon: PencilIcon, run: () => setRenaming(path) },
													{ label: "Delete", icon: Trash2Icon, run: () => void remove(path), danger: true },
												]
											: [
													{ label: "Open in new tab", icon: PlusIcon, run: () => open(path, { newTab: true }) },
													{ label: "Rename", icon: PencilIcon, run: () => setRenaming(path) },
													{ label: bookmarks.includes(path) ? "Remove bookmark" : "Bookmark", icon: BookmarkIcon, run: () => toggleBookmark(path) },
													{ label: "Copy wikilink", icon: Link2Icon, run: () => resolver && void navigator.clipboard?.writeText(`[[${resolver.linkText(path)}]]`) },
													{ label: "Delete", icon: Trash2Icon, run: () => void remove(path), danger: true },
												];
										setMenu({ x: e.clientX, y: e.clientY, items });
									}}
								/>
							)}
							{leftTab === "search" && <SearchPanel q={searchQ} setQ={setSearchQ} onOpen={(p, line) => { open(p); if (line !== undefined) setTimeout(() => setTabs((ts) => ts.map((t) => (t.path === p ? { ...t, scrollTo: { line, nonce: Date.now() } } : t))), 120); }} />}
							{leftTab === "tags" && (
								<TagTree tags={index.tags} onPick={(t) => { setLeftTab("search"); setSearchQ(`tag:#${t}`); }} />
							)}
							{leftTab === "bookmarks" && (
								<div className="flex flex-col px-1">
									{bookmarks.length === 0 && <Empty text="Bookmark notes from their ⋯ menu or right-click." />}
									{bookmarks.map((b) => (
										<Row key={b} icon={BookmarkIcon} label={Notes.noteTitle(b)} detail={Notes.dirname(b)} active={active?.path === b} onClick={() => open(b)} />
									))}
									{recent.length > 0 && (
										<>
											<div className="mt-3 px-2 pb-1 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">Recent</div>
											{recent.filter((r) => index.files.some((f) => f.path === r)).slice(0, 12).map((r) => (
												<Row key={r} icon={FileTextIcon} label={Notes.noteTitle(r)} detail={Notes.dirname(r)} onClick={() => open(r)} />
											))}
										</>
									)}
								</div>
							)}
						</div>
						<div className="flex items-center gap-1 border-t px-2 py-1.5 font-ui text-[10px] text-muted-foreground">
							<span className="truncate" title={vault?.root}>
								{index.notes.length} notes · {vault?.custom ? Notes.basename(vault.root) : "Meander vault"}
							</span>
							<IconBtn icon={Settings2Icon} label="Notes settings" className="ml-auto" onClick={() => setModal("settings")} />
						</div>
					</aside>
				)}
				{narrow && (leftOpen || rightOpen) && <div className="absolute inset-0 z-20 bg-black/30" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />}

				{/* Main */}
				<main className="flex min-w-0 flex-1 flex-col">
					{!active && (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
							<div className="font-title text-2xl text-foreground">Notes</div>
							<div className="flex flex-col items-center gap-1 font-ui text-xs">
								<button type="button" className="hover:text-foreground" onClick={() => void createNote({})}>Create new note (⌘N)</button>
								<button type="button" className="hover:text-foreground" onClick={() => setModal("switcher")}>Go to file (⌘O)</button>
								<button type="button" className="hover:text-foreground" onClick={() => void openDaily()}>Today&apos;s note (⌘⇧D)</button>
								<button type="button" className="hover:text-foreground" onClick={openGraph}>Graph view (⌘G)</button>
							</div>
						</div>
					)}
					{active?.kind === "graph" && <NotesGraph index={index} active={null} local={false} onOpen={(p) => open(p)} />}
					{active?.kind === "file" && active.path && <FileViewer path={active.path} />}
					{active?.kind === "base" && active.path && active.loaded && (
						<div className="flex min-h-0 flex-1 flex-col">
							<NoteHeader
								path={active.path}
								renaming={renaming === active.path}
								onRename={(to) => { setRenaming(null); if (to) void rename(active.path!, to); }}
								onStartRename={() => setRenaming(active.path)}
							/>
							<BaseView
								config={Notes.parseBase(active.text)}
								onConfig={(cfg) => setText(active.id, Notes.stringifyBase(cfg))}
								notes={index.notes}
								index={index}
								onOpen={(p) => open(p)}
								onSetProp={(p, k, v) => void setPropOn(p, k, v)}
								onNewNote={(props) => void createNote({ open: true }).then((p) => p && setTimeout(() => void setPropOn(p, Object.keys(props)[0]!, Object.values(props)[0]!), 300))}
							/>
						</div>
					)}
					{active?.kind === "note" && active.path && (
						<div className="flex min-h-0 flex-1 flex-col">
							<div className="flex items-center gap-1 px-4 pt-2 font-ui text-xs text-muted-foreground">
								<span className="truncate">{Notes.dirname(active.path).split("/").filter(Boolean).join(" / ")}</span>
								<div className="ml-auto flex items-center gap-0.5">
									<ModeSwitch mode={active.mode} onMode={(m) => setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, mode: m, nonce: t.nonce + 1 } : t)))} />
									<IconBtn icon={GraduationCapIcon} label="Teach me this note" onClick={() => void teach("teach")} />
									<IconBtn
										icon={MoreHorizontalIcon}
										label="More"
										onClick={(e) =>
											setMenu({
												x: (e as React.MouseEvent).clientX - 200,
												y: (e as React.MouseEvent).clientY + 10,
												items: [
													{ label: "Teach me this", icon: GraduationCapIcon, run: () => void teach("teach") },
													{ label: "Practice this", icon: DumbbellIcon, run: () => void teach("practice") },
													{ label: "Add to knowledge graph", icon: SparklesIcon, run: () => void addToGraph() },
													{ label: "Add property", icon: PlusIcon, run: () => { const k = prompt("Property name"); if (k) setProps({ ...fm!.props, [k.trim()]: null }); } },
													{ label: "Insert template", icon: FileTextIcon, run: () => setModal("template") },
													{ label: bookmarks.includes(active.path!) ? "Remove bookmark" : "Bookmark", icon: BookmarkIcon, run: () => toggleBookmark(active.path!) },
													{ label: "Rename", icon: PencilIcon, run: () => setRenaming(active.path) },
													{ label: "Move to folder…", icon: FolderOpenIcon, run: () => setModal("move") },
													{ label: "Copy wikilink", icon: Link2Icon, run: () => resolver && void navigator.clipboard?.writeText(`[[${resolver.linkText(active.path!)}]]`).then(() => flash("Link copied.")) },
													{ label: "Delete", icon: Trash2Icon, run: () => void remove(active.path!), danger: true },
												],
											})
										}
									/>
								</div>
							</div>
							{active.conflict && (
								<div className="mx-4 mt-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 font-ui text-xs">
									This note changed on disk (another device or app) while you were editing.
									<button type="button" className="rounded border px-2 py-0.5 hover:bg-accent" onClick={() => void loadTab(active.id, active.path!, true)}>
										Load the disk version
									</button>
									<button
										type="button"
										className="rounded border px-2 py-0.5 hover:bg-accent"
										onClick={() => {
											setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, conflict: null, mtime: active.conflict!.mtime } : t)));
											setTimeout(() => void flushSave(active.id), 0);
										}}
									>
										Keep mine (overwrite)
									</button>
								</div>
							)}
							<div className="min-h-0 flex-1 overflow-y-auto" data-testid="note-scroll">
								<div className={cn("mx-auto px-6 pb-[40vh] pt-4", prefs.readableWidth ? "max-w-[46rem]" : "max-w-none")}>
									<NoteHeader
										path={active.path}
										renaming={renaming === active.path}
										onRename={(to) => { setRenaming(null); if (to) void rename(active.path!, to); }}
										onStartRename={() => setRenaming(active.path)}
										big
									/>
									{active.mode !== "source" && fm && (fm.present || Object.keys(fm.props).length > 0) && (
										<PropertiesBlock props={fm.props} onChange={setProps} readOnly={active.mode === "reading"} index={index} onOpen={(t) => host.openLink(t, false)} />
									)}
									{!active.loaded ? (
										<div className="py-8 font-ui text-xs text-muted-foreground">Loading…</div>
									) : active.mode === "reading" ? (
										<NoteReader
											text={active.text}
											resolve={resolveForReading}
											readNote={readNote}
											onOpen={(p, sub, newTab) => open(p, { sub, newTab })}
											onTag={host.openTag}
											onCreate={(t) => void createNote({ title: t, folder: prefs.newNoteFolder })}
											onToggleTask={(i) => {
												const task = Notes.extractTasks(active.text)[i];
												if (task) setText(active.id, Notes.toggleTaskLine(active.text, task.line));
											}}
										/>
									) : (
										<NoteEditor
											key={`${active.id}:${active.mode}:${active.nonce}`}
											docKey={`${active.id}:${active.mode}:${active.nonce}`}
											initial={editorDoc}
											mode={active.mode === "source" ? "source" : "live"}
											host={host}
											handleRef={editorHandle}
											spellcheck={prefs.spellcheck}
											scrollToLine={active.scrollTo ? { line: Math.max(0, active.scrollTo.line - (active.mode === "source" ? 0 : fmLines)), nonce: active.scrollTo.nonce } : null}
											onCursorLine={(l) => setCursorLine(l + (active.mode === "source" ? 0 : fmLines))}
											onChange={(doc) => {
												const cur = tabsRef.current.find((t) => t.id === active.id);
												if (!cur) return;
												if (active.mode === "source") setText(active.id, doc);
												else {
													const f = Notes.parseFrontmatter(cur.text);
													setText(active.id, (f.present ? cur.text.slice(0, f.bodyStart) : "") + doc);
												}
											}}
										/>
									)}
								</div>
							</div>
							<div className="flex items-center justify-end gap-3 border-t px-3 py-1 font-ui text-[10px] text-muted-foreground">
								{activeMeta && activeMeta.tasks.total > 0 && <span>{activeMeta.tasks.done}/{activeMeta.tasks.total} tasks</span>}
								<span>{(index.backlinks[active.path] ?? []).length} backlinks</span>
								<span>{Notes.wordCount(active.text)} words</span>
								<span>{active.text.length} characters</span>
								<span>{active.conflict ? "conflict" : active.text === active.saved ? "saved" : "saving…"}</span>
							</div>
						</div>
					)}
				</main>

				{/* Right sidebar */}
				{rightOpen && (
					<aside className={cn("flex w-72 shrink-0 flex-col border-l bg-card/40", narrow && "absolute inset-y-0 right-0 z-30 w-[85vw] max-w-80 bg-background shadow-2xl")} data-testid="notes-right">
						<div className="flex items-center gap-0.5 border-b px-2 py-1.5">
							{([["backlinks", Link2Icon, "Backlinks"], ["outgoing", WaypointsIcon, "Outgoing links"], ["outline", ListTreeIcon, "Outline"], ["graph", NetworkIcon, "Local graph"]] as const).map(([k, Icon, lbl]) => (
								<IconBtn key={k} icon={Icon} label={lbl} active={rightTab === k} onClick={() => setRightTab(k)} />
							))}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{!active?.path || active.kind !== "note" ? (
								<Empty text="Open a note to see its links, outline and neighborhood." />
							) : rightTab === "backlinks" ? (
								<BacklinksPanel path={active.path} indexKey={index.files.length + ":" + (index.backlinks[active.path] ?? []).join("|")} onOpen={(p, line) => { open(p); if (line !== undefined) setTimeout(() => setTabs((ts) => ts.map((t) => (t.path === p ? { ...t, scrollTo: { line, nonce: Date.now() } } : t))), 150); }} onLinkMention={async (p) => {
									const title = Notes.noteTitle(active.path!);
									const r = await api<{ content: string; mtime: number }>(`/api/notes/file?path=${encodeURIComponent(p)}`);
									const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${Notes.escapeRe(title)})(?=$|[^\\p{L}\\p{N}\\]])`, "iu");
									const next = r.content.replace(re, (_m, pre: string, word: string) => `${pre}[[${word === title ? title : `${title}|${word}`}]]`);
									if (next !== r.content) {
										await api("/api/notes/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, content: next, baseMtime: r.mtime }) });
										await refresh();
										flash("Linked.");
									}
								}} />
							) : rightTab === "outgoing" ? (
								<div className="flex flex-col px-1 py-1">
									{(activeMeta?.links ?? []).length === 0 && <Empty text="No outgoing links." />}
									{dedupe(activeMeta?.links ?? []).map((l, i) => (
										<Row key={i} icon={l.path ? (Notes.isNotePath(l.path) ? FileTextIcon : ImageIcon) : FilePlusIcon} label={l.path ? Notes.noteTitle(l.path) : l.target} detail={l.path ? (l.heading ? `› ${l.heading}` : undefined) : "not created yet"} muted={!l.path} onClick={() => (l.path ? open(l.path, { sub: l.heading ?? null }) : void createNote({ title: l.target, folder: prefs.newNoteFolder }))} />
									))}
								</div>
							) : rightTab === "outline" ? (
								<div className="flex flex-col py-1">
									{Notes.extractHeadings(active.text).length === 0 && <Empty text="No headings." />}
									{Notes.extractHeadings(active.text).map((h, i, all) => {
										const next = all[i + 1];
										const current = cursorLine >= h.line && (!next || cursorLine < next.line);
										return (
											<button
												key={i}
												type="button"
												style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
												className={cn("truncate py-1 pr-2 text-left text-xs hover:bg-accent", current ? "text-foreground" : "text-muted-foreground")}
												onClick={() => {
													if (active.mode === "reading") {
														const el = [...document.querySelectorAll(".lh-note-reading h1, .lh-note-reading h2, .lh-note-reading h3, .lh-note-reading h4, .lh-note-reading h5, .lh-note-reading h6")].find((x) => Notes.slugHeading(x.textContent ?? "") === Notes.slugHeading(h.text));
														el?.scrollIntoView({ behavior: "smooth", block: "start" });
													} else setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, scrollTo: { line: h.line, nonce: Date.now() } } : t)));
												}}
											>
												{h.text}
											</button>
										);
									})}
								</div>
							) : (
								<div className="h-full min-h-80">
									<NotesGraph index={index} active={active.path} local compact onOpen={(p) => open(p)} />
								</div>
							)}
						</div>
					</aside>
				)}
			</div>

			{/* Overlays */}
			{modal === "switcher" && (
				<Picker
					placeholder="Find or create a note…"
					items={[...index.notes.map((n) => ({ key: n.path, label: n.title, detail: n.folder, aliases: n.aliases, mtime: n.mtime })), ...index.files.filter((f) => !Notes.isNotePath(f.path)).map((f) => ({ key: f.path, label: Notes.basename(f.path), detail: Notes.dirname(f.path), aliases: [] as string[], mtime: f.mtime }))]}
					recent={recent}
					onPick={(k, newTab) => {
						setModal(null);
						open(k, { newTab });
					}}
					onCreate={(q) => {
						setModal(null);
						void createNote({ title: q, folder: q.includes("/") ? undefined : prefs.newNoteFolder });
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{modal === "palette" && (
				<Picker
					placeholder="Run a command…"
					items={commands.map((c) => ({ key: c.id, label: c.label, detail: c.hint ?? "", aliases: [], mtime: 0 }))}
					onPick={(k) => {
						setModal(null);
						commands.find((c) => c.id === k)?.run();
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{modal === "template" && (
				<Picker
					placeholder={templates.length ? "Insert template…" : `No templates yet — add notes to the "${prefs.templatesFolder}" folder`}
					items={templates.map((t) => ({ key: t.path, label: t.title, detail: t.folder, aliases: [], mtime: t.mtime }))}
					onPick={(k) => {
						setModal(null);
						void applyTemplate(k);
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{modal === "move" && active?.path && (
				<Picker
					placeholder="Move to folder…"
					items={[{ key: "", label: "/ (vault root)", detail: "", aliases: [], mtime: 0 }, ...index.folders.map((f) => ({ key: f, label: f, detail: "", aliases: [], mtime: 0 }))]}
					onPick={(k) => {
						setModal(null);
						void rename(active.path!, k ? `${k}/${Notes.basename(active.path!)}` : Notes.basename(active.path!));
					}}
					onCreate={(q) => {
						setModal(null);
						void rename(active.path!, `${q.replace(/\/+$/, "")}/${Notes.basename(active.path!)}`);
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{modal === "settings" && (
				<SettingsModal
					prefs={prefs}
					vault={vault}
					notes={index.notes}
					onPrefs={(p) => {
						setPrefs(p);
						save(PREFS_KEY, p);
					}}
					onVault={async (path) => {
						try {
							await api("/api/notes/vault", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
							setTabs([]);
							setActiveId(null);
							booted.current = false;
							await refresh();
							flash("Vault switched.");
						} catch (err) {
							flash((err as Error).message);
						}
					}}
					onClose={() => setModal(null)}
				/>
			)}
			{menu && (
				<div className="fixed z-50 flex min-w-48 flex-col rounded-lg border bg-popover p-1 font-ui text-xs shadow-xl" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)), top: Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 16) }} onPointerDown={(e) => e.stopPropagation()}>
					{menu.items.map((it) => (
						<button
							key={it.label}
							type="button"
							className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", it.danger && "text-destructive")}
							onClick={() => {
								setMenu(null);
								it.run();
							}}
						>
							{it.icon && <it.icon className="size-3.5" />}
							{it.label}
						</button>
					))}
				</div>
			)}
			{lightbox && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6" onClick={() => setLightbox(null)} data-testid="notes-lightbox">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={lightbox.src} alt={lightbox.alt} className="max-h-full max-w-full object-contain shadow-2xl" />
					<button type="button" aria-label="Close" className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white" onClick={() => setLightbox(null)}>
						<XIcon className="size-4" />
					</button>
				</div>
			)}
			{toast && <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 font-ui text-xs shadow-xl">{toast}</div>}
		</div>
	);
}

function dedupe<T extends { path: string | null; target: string }>(ls: T[]): T[] {
	const seen = new Set<string>();
	return ls.filter((l) => {
		const k = l.path ?? "?" + l.target;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

// ─── Small pieces ───────────────────────────────────────────────────────────

function IconBtn({ icon: Icon, label, onClick, active, className }: { icon: LucideIcon; label: string; onClick: (e: React.MouseEvent) => void; active?: boolean; className?: string }) {
	return (
		<button type="button" aria-label={label} title={label} onClick={onClick} className={cn("flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", active && "bg-accent text-foreground", className)}>
			<Icon className="size-3.5" />
		</button>
	);
}

function Empty({ text }: { text: string }) {
	return <div className="px-4 py-6 text-center font-ui text-xs text-muted-foreground">{text}</div>;
}

function Row({ icon: Icon, label, detail, active, muted, onClick }: { icon: LucideIcon; label: string; detail?: string; active?: boolean; muted?: boolean; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent", active ? "bg-accent text-foreground" : muted ? "text-muted-foreground/70" : "text-muted-foreground hover:text-foreground")}>
			<Icon className="size-3 shrink-0" />
			<span className="truncate">{label}</span>
			{detail && <span className="ml-auto shrink-0 truncate pl-2 text-[10px] opacity-60">{detail}</span>}
		</button>
	);
}

function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
	return (
		<div className="flex items-center rounded-md border p-0.5" role="radiogroup" aria-label="View mode">
			{([["live", PencilIcon, "Live Preview"], ["source", CodeIcon, "Source mode"], ["reading", EyeIcon, "Reading view (⌘E)"]] as const).map(([m, Icon, lbl]) => (
				<button key={m} type="button" role="radio" aria-checked={mode === m} title={lbl} aria-label={lbl} onClick={() => onMode(m)} className={cn("rounded p-1", mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")} data-testid={`mode-${m}`}>
					<Icon className="size-3" />
				</button>
			))}
		</div>
	);
}

function NoteHeader({ path, renaming, onRename, onStartRename, big }: { path: string; renaming: boolean; onRename: (to: string | null) => void; onStartRename: () => void; big?: boolean }) {
	const title = Notes.noteTitle(path);
	const ext = Notes.extOf(path);
	const commit = (v: string) => {
		const clean = v.replace(Notes.ILLEGAL_NAME_CHARS, " ").trim();
		if (!clean || clean === title) return onRename(null);
		const dir = Notes.dirname(path);
		onRename(`${dir ? dir + "/" : ""}${clean}${ext}`);
	};
	if (renaming)
		return (
			<input
				autoFocus
				defaultValue={title}
				onFocus={(e) => e.currentTarget.select()}
				onBlur={(e) => commit(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") commit(e.currentTarget.value);
					if (e.key === "Escape") onRename(null);
				}}
				className={cn("w-full bg-transparent font-title outline-none", big ? "mb-3 text-3xl" : "px-4 py-2 text-lg")}
				data-testid="note-title-input"
			/>
		);
	return (
		<h1 onClick={onStartRename} className={cn("cursor-text font-title", big ? "mb-3 text-3xl leading-tight" : "px-4 py-2 text-lg")} data-testid="note-title">
			{title}
		</h1>
	);
}

function PropertiesBlock({ props, onChange, readOnly, index, onOpen }: { props: Notes.Props; onChange: (p: Notes.Props) => void; readOnly: boolean; index: Notes.VaultIndex; onOpen: (target: string) => void }) {
	const [open, setOpen] = useState(true);
	const entries = Object.entries(props);
	const keys = useMemo(() => Notes.allPropKeys(index.notes), [index.notes]);
	return (
		<div className="mb-4 rounded-lg border bg-card/40 px-3 py-2 font-ui text-xs" data-testid="note-properties">
			<button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-muted-foreground">
				{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				Properties
			</button>
			{open && (
				<div className="mt-1.5 flex flex-col gap-1">
					{entries.map(([k, v]) => (
						<div key={k} className="group flex items-start gap-2">
							<span className="w-28 shrink-0 truncate pt-1 text-muted-foreground" title={k}>
								{k}
							</span>
							{readOnly ? (
								<PropDisplay v={v} onOpen={onOpen} />
							) : typeof v === "boolean" ? (
								<input type="checkbox" checked={v} onChange={(e) => onChange({ ...props, [k]: e.target.checked })} className="mt-1" />
							) : (
								<input
									key={Notes.propToText(v)}
									defaultValue={Array.isArray(v) ? v.map((x) => Notes.propToText(x)).join(", ") : Notes.propToText(v)}
									placeholder="Empty"
									className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 hover:bg-accent/60 focus:bg-accent/60"
									onBlur={(e) => {
										const raw = e.currentTarget.value;
										let next: Notes.PropValue;
										if (Array.isArray(v) || k === "tags" || k === "aliases") next = raw.split(",").map((s) => s.trim()).filter(Boolean);
										else if (raw === "") next = null;
										else if (/^-?\d+(\.\d+)?$/.test(raw)) next = Number(raw);
										else next = raw;
										if (JSON.stringify(next) !== JSON.stringify(v)) onChange({ ...props, [k]: next });
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") e.currentTarget.blur();
									}}
								/>
							)}
							{!readOnly && (
								<button type="button" aria-label={`Remove ${k}`} className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100" onClick={() => { const n = { ...props }; delete n[k]; onChange(n); }}>
									<XIcon className="size-3" />
								</button>
							)}
						</div>
					))}
					{!readOnly && (
						<div className="flex items-center gap-1">
							<input
								list="lh-prop-keys"
								placeholder="+ Add property"
								className="w-28 rounded bg-transparent px-1 py-0.5 text-muted-foreground hover:bg-accent/60"
								onKeyDown={(e) => {
									if (e.key === "Enter" && e.currentTarget.value.trim()) {
										onChange({ ...props, [e.currentTarget.value.trim()]: null });
										e.currentTarget.value = "";
									}
								}}
							/>
							<datalist id="lh-prop-keys">
								{keys.map((k) => (
									<option key={k} value={k} />
								))}
							</datalist>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function PropDisplay({ v, onOpen }: { v: Notes.PropValue; onOpen: (t: string) => void }) {
	const items = Array.isArray(v) ? v : [v];
	return (
		<span className="flex flex-wrap gap-1 pt-1">
			{items.map((x, i) => {
				const s = Notes.propToText(x);
				const link = /^\[\[([^\]]+)\]\]$/.exec(s);
				if (link)
					return (
						<button key={i} type="button" className="lh-note-link" onClick={() => onOpen(link[1]!)}>
							{link[1]!.split("|").pop()}
						</button>
					);
				return <span key={i}>{s}</span>;
			})}
		</span>
	);
}

interface TreeNode {
	name: string;
	path: string;
	folder: boolean;
	children: TreeNode[];
}

function buildTree(index: Notes.VaultIndex): TreeNode {
	const root: TreeNode = { name: "", path: "", folder: true, children: [] };
	const folders = new Map<string, TreeNode>([["", root]]);
	const ensure = (p: string): TreeNode => {
		if (folders.has(p)) return folders.get(p)!;
		const parent = ensure(Notes.dirname(p));
		const node: TreeNode = { name: Notes.basename(p), path: p, folder: true, children: [] };
		parent.children.push(node);
		folders.set(p, node);
		return node;
	};
	for (const f of index.folders) ensure(f);
	for (const f of index.files) ensure(Notes.dirname(f.path)).children.push({ name: Notes.basename(f.path), path: f.path, folder: false, children: [] });
	const sort = (n: TreeNode) => {
		n.children.sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
		n.children.forEach(sort);
	};
	sort(root);
	return root;
}

function FileTree({ index, activePath, renaming, onRenameDone, onOpen, onMove, onContext }: { index: Notes.VaultIndex; activePath: string | null; renaming: string | null; onRenameDone: (from: string, to: string | null) => void; onOpen: (p: string, newTab: boolean) => void; onMove: (from: string, toFolder: string) => void; onContext: (e: React.MouseEvent, path: string, folder: boolean) => void }) {
	const tree = useMemo(() => buildTree(index), [index]);
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadArr("lh:notes-collapsed")));
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const toggle = (p: string) =>
		setCollapsed((c) => {
			const n = new Set(c);
			if (n.has(p)) n.delete(p);
			else n.add(p);
			save("lh:notes-collapsed", [...n]);
			return n;
		});
	const render = (node: TreeNode, depth: number): React.ReactNode =>
		node.children.map((c) => {
			const isOpen = !collapsed.has(c.path);
			const pad = { paddingLeft: 8 + depth * 14 };
			if (renaming === c.path) {
				const ext = c.folder ? "" : Notes.extOf(c.name);
				const stem = c.folder ? c.name : Notes.noteTitle(c.name);
				const done = (v: string) => {
					const clean = v.replace(Notes.ILLEGAL_NAME_CHARS, " ").trim();
					const dir = Notes.dirname(c.path);
					onRenameDone(c.path, clean && clean !== stem ? `${dir ? dir + "/" : ""}${clean}${ext}` : null);
				};
				return (
					<div key={c.path} style={pad} className="pr-2">
						<input autoFocus defaultValue={stem} onFocus={(e) => e.currentTarget.select()} onBlur={(e) => done(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") done(e.currentTarget.value); if (e.key === "Escape") onRenameDone(c.path, null); }} className="w-full rounded border bg-background px-1 py-0.5 text-xs" />
					</div>
				);
			}
			if (c.folder)
				return (
					<div key={c.path}>
						<button
							type="button"
							style={pad}
							draggable
							onDragStart={(e) => e.dataTransfer.setData("application/x-lh-note", c.path)}
							onDragOver={(e) => { e.preventDefault(); setDropTarget(c.path); }}
							onDragLeave={() => setDropTarget((d) => (d === c.path ? null : d))}
							onDrop={(e) => { e.preventDefault(); setDropTarget(null); const p = e.dataTransfer.getData("application/x-lh-note"); if (p && p !== c.path && !c.path.startsWith(p + "/")) onMove(p, c.path); }}
							onClick={() => toggle(c.path)}
							onContextMenu={(e) => onContext(e, c.path, true)}
							className={cn("flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground", dropTarget === c.path && "bg-accent ring-1 ring-ring")}
						>
							{isOpen ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
							<span className="truncate">{c.name}</span>
						</button>
						{isOpen && render(c, depth + 1)}
					</div>
				);
			const kind = kindOf(c.path);
			return (
				<button
					key={c.path}
					type="button"
					style={{ paddingLeft: 8 + depth * 14 + 14 }}
					draggable
					onDragStart={(e) => {
						e.dataTransfer.setData("application/x-lh-note", c.path);
						e.dataTransfer.setData("text/plain", `[[${Notes.noteTitle(c.path)}]]`);
					}}
					onClick={(e) => onOpen(c.path, e.metaKey || e.ctrlKey)}
					onAuxClick={(e) => e.button === 1 && onOpen(c.path, true)}
					onContextMenu={(e) => onContext(e, c.path, false)}
					className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs hover:bg-accent", activePath === c.path ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
					data-testid="tree-file"
				>
					{kind === "base" ? <DatabaseIcon className="size-3 shrink-0 opacity-70" /> : kind === "file" ? <ImageIcon className="size-3 shrink-0 opacity-70" /> : null}
					<span className="truncate">{kind === "note" ? Notes.noteTitle(c.name) : c.name}</span>
				</button>
			);
		});
	return (
		<div
			className="flex min-h-full flex-col px-1"
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => {
				const p = e.dataTransfer.getData("application/x-lh-note");
				if (p && Notes.dirname(p) !== "" && e.target === e.currentTarget) onMove(p, "");
			}}
		>
			{tree.children.length === 0 ? <Empty text="No notes yet." /> : render(tree, 0)}
		</div>
	);
}

function TagTree({ tags, onPick }: { tags: Notes.VaultIndex["tags"]; onPick: (t: string) => void }) {
	const list = Object.values(tags).sort((a, b) => a.tag.localeCompare(b.tag));
	if (!list.length) return <Empty text="No tags yet. Type #tag in a note or add tags: in its properties." />;
	return (
		<div className="flex flex-col px-1">
			{list.map((t) => {
				const depth = t.tag.split("/").length - 1;
				return (
					<button key={t.tag} type="button" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(t.tag)} className="flex items-center gap-1 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
						<HashIcon className="size-3 shrink-0" />
						<span className="truncate">{t.tag.split("/").pop()}</span>
						<span className="ml-auto text-[10px] opacity-60">{t.count}</span>
					</button>
				);
			})}
		</div>
	);
}

function SearchPanel({ q, setQ, onOpen }: { q: string; setQ: (q: string) => void; onOpen: (p: string, line?: number) => void }) {
	const [hits, setHits] = useState<Notes.SearchHit[]>([]);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!q.trim()) {
			setHits([]);
			return;
		}
		setBusy(true);
		const id = setTimeout(() => {
			fetch(`/api/notes/search?q=${encodeURIComponent(q)}`)
				.then((r) => r.json())
				.then((b: { hits?: Notes.SearchHit[] }) => setHits(b.hits ?? []))
				.finally(() => setBusy(false));
		}, 180);
		return () => clearTimeout(id);
	}, [q]);
	return (
		<div className="flex flex-col gap-1 px-2">
			<input data-notes-search autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="rounded-md border bg-background px-2 py-1.5 text-xs" />
			<div className="px-1 font-ui text-[10px] leading-snug text-muted-foreground">tag:#x · path:folder · file:name · &quot;phrase&quot; · -exclude · [prop:value] · task-todo: · /regex/</div>
			{busy && <div className="px-1 font-ui text-[10px] text-muted-foreground">Searching…</div>}
			{!busy && q.trim() && <div className="px-1 font-ui text-[10px] text-muted-foreground">{hits.length} result{hits.length === 1 ? "" : "s"}</div>}
			{hits.map((h) => (
				<div key={h.path} className="flex flex-col">
					<button type="button" onClick={() => onOpen(h.path)} className="truncate rounded px-1 py-1 text-left text-xs font-medium hover:bg-accent">
						{h.title}
					</button>
					{h.matches.slice(0, 4).map((m) => (
						<button key={m.line} type="button" onClick={() => onOpen(h.path, m.line)} className="truncate rounded px-2 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent">
							{highlightRanges(m.text, m.ranges)}
						</button>
					))}
				</div>
			))}
		</div>
	);
}

function highlightRanges(text: string, ranges: [number, number][]) {
	if (!ranges.length) return text;
	const out: React.ReactNode[] = [];
	let last = 0;
	ranges.forEach(([a, b], i) => {
		if (a < last) return;
		out.push(text.slice(last, a));
		out.push(<mark key={i} className="rounded bg-[var(--lh-mark)] px-0.5 text-foreground">{text.slice(a, b)}</mark>);
		last = b;
	});
	out.push(text.slice(last));
	return out;
}

function BacklinksPanel({ path, indexKey, onOpen, onLinkMention }: { path: string; indexKey: string; onOpen: (p: string, line?: number) => void; onLinkMention: (p: string) => Promise<void> }) {
	const [data, setData] = useState<{ linked: { path: string; title: string; hits: { line: number; snippet: string }[] }[]; mentions: { path: string; line: number; snippet: string }[] } | null>(null);
	const [showMentions, setShowMentions] = useState(false);
	useEffect(() => {
		let alive = true;
		fetch(`/api/notes/backlinks?path=${encodeURIComponent(path)}`)
			.then((r) => r.json())
			.then((b) => alive && setData(b))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [path, indexKey]);
	if (!data) return <Empty text="Loading…" />;
	return (
		<div className="flex flex-col gap-1 px-2 py-2" data-testid="backlinks">
			<div className="px-1 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">Linked mentions · {data.linked.length}</div>
			{data.linked.length === 0 && <div className="px-1 py-2 font-ui text-xs text-muted-foreground">No backlinks yet.</div>}
			{data.linked.map((l) => (
				<div key={l.path} className="flex flex-col rounded-md border bg-background/50 p-1.5">
					<button type="button" onClick={() => onOpen(l.path)} className="truncate text-left text-xs font-medium hover:underline">
						{l.title}
					</button>
					{l.hits.map((h) => (
						<button key={h.line} type="button" onClick={() => onOpen(l.path, h.line)} className="mt-0.5 line-clamp-2 text-left text-[11px] text-muted-foreground hover:text-foreground">
							{h.snippet}
						</button>
					))}
				</div>
			))}
			<button type="button" onClick={() => setShowMentions((v) => !v)} className="mt-3 flex items-center gap-1 px-1 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
				{showMentions ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				Unlinked mentions · {data.mentions.length}
			</button>
			{showMentions &&
				data.mentions.map((m) => (
					<div key={m.path} className="flex flex-col rounded-md border bg-background/50 p-1.5">
						<div className="flex items-center gap-1">
							<button type="button" onClick={() => onOpen(m.path, m.line)} className="truncate text-left text-xs font-medium hover:underline">
								{Notes.noteTitle(m.path)}
							</button>
							<button type="button" onClick={() => void onLinkMention(m.path)} className="ml-auto rounded border px-1.5 py-0.5 font-ui text-[10px] hover:bg-accent">
								Link
							</button>
						</div>
						<div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{m.snippet}</div>
					</div>
				))}
		</div>
	);
}

function FileViewer({ path }: { path: string }) {
	const src = Notes.rawHref(path);
	const ext = Notes.extOf(path);
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
			{Notes.isImagePath(path) ? (
				// eslint-disable-next-line @next/next/no-img-element
				<img src={src} alt={Notes.basename(path)} className="max-h-full max-w-full cursor-zoom-in object-contain" onClick={() => window.dispatchEvent(new CustomEvent("lh:notes-lightbox", { detail: { src, alt: Notes.basename(path) } }))} />
			) : ext === ".pdf" ? (
				<iframe src={src} className="h-full w-full rounded border" title={Notes.basename(path)} />
			) : [".mp3", ".wav", ".m4a"].includes(ext) ? (
				<audio src={src} controls />
			) : [".mp4", ".webm", ".mov"].includes(ext) ? (
				<video src={src} controls className="max-h-full max-w-full" />
			) : (
				<a href={src} className="lh-note-link">
					Open {Notes.basename(path)}
				</a>
			)}
		</div>
	);
}

function Picker({ placeholder, items, recent = [], onPick, onCreate, onClose }: { placeholder: string; items: { key: string; label: string; detail: string; aliases: string[]; mtime: number }[]; recent?: string[]; onPick: (key: string, newTab: boolean) => void; onCreate?: (q: string) => void; onClose: () => void }) {
	const [q, setQ] = useState("");
	const [sel, setSel] = useState(0);
	const list = useMemo(() => {
		if (!q.trim()) {
			const byRecent = [...items].sort((a, b) => {
				const ra = recent.indexOf(a.key);
				const rb = recent.indexOf(b.key);
				if (ra >= 0 || rb >= 0) return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb);
				return b.mtime - a.mtime;
			});
			return byRecent.slice(0, 50);
		}
		return items
			.map((it) => ({ it, s: Math.max(Notes.fuzzyMatch(q, it.label) + 5, Notes.fuzzyMatch(q, `${it.detail}/${it.label}`), ...it.aliases.map((a) => Notes.fuzzyMatch(q, a))) }))
			.filter((x) => x.s >= 0)
			.sort((a, b) => b.s - a.s)
			.slice(0, 50)
			.map((x) => x.it);
	}, [q, items, recent]);
	const canCreate = !!onCreate && q.trim() && !items.some((i) => i.label.toLowerCase() === q.trim().toLowerCase());
	const total = list.length + (canCreate ? 1 : 0);
	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]" onClick={onClose}>
			<div className="w-[min(36rem,92vw)] overflow-hidden rounded-xl border bg-popover shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="notes-picker">
				<input
					autoFocus
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						setSel(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setSel((s) => Math.min(s + 1, total - 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setSel((s) => Math.max(s - 1, 0));
						} else if (e.key === "Enter") {
							e.preventDefault();
							if ((e.shiftKey || sel >= list.length) && canCreate) onCreate!(q.trim());
							else if (list[sel]) onPick(list[sel]!.key, e.metaKey || e.ctrlKey);
						} else if (e.key === "Escape") onClose();
						e.stopPropagation();
					}}
					placeholder={placeholder}
					className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
				/>
				<div className="max-h-[50vh] overflow-y-auto p-1">
					{list.map((it, i) => (
						<button key={it.key} type="button" onMouseEnter={() => setSel(i)} onClick={(e) => onPick(it.key, e.metaKey || e.ctrlKey)} className={cn("flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm", i === sel ? "bg-accent text-foreground" : "text-muted-foreground")}>
							<span className="truncate">{it.label}</span>
							{it.detail && <span className="ml-auto shrink-0 truncate font-ui text-[11px] opacity-60">{it.detail}</span>}
						</button>
					))}
					{canCreate && (
						<button type="button" onMouseEnter={() => setSel(list.length)} onClick={() => onCreate!(q.trim())} className={cn("flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm", sel === list.length ? "bg-accent text-foreground" : "text-muted-foreground")}>
							<FilePlusIcon className="size-3.5" /> Create &ldquo;{q.trim()}&rdquo; <span className="ml-auto font-ui text-[11px] opacity-60">⇧↵</span>
						</button>
					)}
					{total === 0 && <div className="px-3 py-4 text-center font-ui text-xs text-muted-foreground">Nothing found.</div>}
				</div>
				<div className="flex gap-3 border-t px-3 py-1.5 font-ui text-[10px] text-muted-foreground">
					<span>↑↓ navigate</span>
					<span>↵ open</span>
					<span>⌘↵ new tab</span>
					{onCreate && <span>⇧↵ create</span>}
					<span>esc close</span>
				</div>
			</div>
		</div>
	);
}

function SettingsModal({ prefs, vault, notes, onPrefs, onVault, onClose }: { prefs: Prefs; vault: { root: string; custom: boolean; defaultRoot: string } | null; notes: Notes.NoteMeta[]; onPrefs: (p: Prefs) => void; onVault: (path: string | null) => Promise<void>; onClose: () => void }) {
	const [folder, setFolder] = useState(vault?.custom ? vault.root : "");
	const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => onPrefs({ ...prefs, [k]: v });
	const row = "flex items-center justify-between gap-3 py-1.5";
	const input = "w-48 rounded border bg-background px-2 py-1 text-xs";
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
			<div className="max-h-[85vh] w-[min(34rem,94vw)] overflow-y-auto rounded-xl border bg-popover p-5 font-ui text-xs shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="notes-settings">
				<div className="mb-3 flex items-center">
					<h2 className="text-sm font-medium">Notes settings</h2>
					<button type="button" aria-label="Close" onClick={onClose} className="ml-auto rounded p-1 hover:bg-accent">
						<XIcon className="size-4" />
					</button>
				</div>
				<div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Vault</div>
				<div className="mb-1 text-muted-foreground">Now: {vault?.root}</div>
				<div className="flex gap-2 py-1">
					<input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={`Default (${vault?.defaultRoot ?? "data/notes"})`} className="flex-1 rounded border bg-background px-2 py-1 text-xs" />
					<button type="button" className="rounded border px-2 hover:bg-accent" onClick={() => void onVault(folder.trim() || null)}>
						Use folder
					</button>
				</div>
				<div className="mb-3 text-[11px] text-muted-foreground">Point this at an existing Obsidian vault to use it as-is (its .obsidian folder is left alone). Paths are on the machine running Meander.</div>

				<div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Files &amp; links</div>
				<label className={row}>
					Default file to open
					<select value={prefs.defaultOpen} onChange={(e) => set("defaultOpen", e.target.value as Prefs["defaultOpen"])} className={input}>
						<option value="last">Last opened files</option>
						<option value="daily">Daily note</option>
						<option value="new">New note</option>
						<option value="specific">Specific note</option>
					</select>
				</label>
				{prefs.defaultOpen === "specific" && (
					<label className={row}>
						Note
						<select value={prefs.specificNote} onChange={(e) => set("specificNote", e.target.value)} className={input}>
							<option value="">—</option>
							{notes.map((n) => (
								<option key={n.path} value={n.path}>
									{n.path}
								</option>
							))}
						</select>
					</label>
				)}
				<label className={row}>
					New notes go in
					<input value={prefs.newNoteFolder} onChange={(e) => set("newNoteFolder", e.target.value)} placeholder="vault root" className={input} />
				</label>
				<label className={row}>
					Attachments folder
					<input value={prefs.attachmentsFolder} onChange={(e) => set("attachmentsFolder", e.target.value)} className={input} />
				</label>
				<label className={row}>
					Confirm before deleting
					<input type="checkbox" checked={prefs.confirmDelete} onChange={(e) => set("confirmDelete", e.target.checked)} />
				</label>

				<div className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Editor</div>
				<label className={row}>
					Default view for new tabs
					<select value={prefs.defaultMode} onChange={(e) => set("defaultMode", e.target.value as Mode)} className={input}>
						<option value="live">Live Preview</option>
						<option value="source">Source mode</option>
						<option value="reading">Reading view</option>
					</select>
				</label>
				<label className={row}>
					Readable line length
					<input type="checkbox" checked={prefs.readableWidth} onChange={(e) => set("readableWidth", e.target.checked)} />
				</label>
				<label className={row}>
					Spellcheck
					<input type="checkbox" checked={prefs.spellcheck} onChange={(e) => set("spellcheck", e.target.checked)} />
				</label>

				<div className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Daily notes &amp; templates</div>
				<label className={row}>
					Daily notes folder
					<input value={prefs.dailyFolder} onChange={(e) => set("dailyFolder", e.target.value)} className={input} />
				</label>
				<label className={row}>
					Daily note name format
					<input value={prefs.dailyFormat} onChange={(e) => set("dailyFormat", e.target.value)} className={input} />
				</label>
				<label className={row}>
					Templates folder
					<input value={prefs.templatesFolder} onChange={(e) => set("templatesFolder", e.target.value)} className={input} />
				</label>
				<div className="text-[11px] text-muted-foreground">A note named &ldquo;Daily&rdquo; in the templates folder becomes the daily-note template. Variables: {"{{title}} {{date}} {{time}} {{date:YYYY-MM-DD}}"}.</div>
			</div>
		</div>
	);
}
