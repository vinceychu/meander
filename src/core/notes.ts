/**
 * NOTES (2026-11-06): the Markdown vault's pure half — Obsidian-compatible
 * parsing (frontmatter properties, [[wikilinks]], ![[embeds]], #tags,
 * headings, block ids, tasks), link resolution, the backlink index, search
 * with operators, link rewriting on rename, related-note ranking (TF-IDF
 * over titles and bodies), inserting a link under a "## Related" heading,
 * and the Bases engine (filtered, sorted, grouped views over note
 * properties: table / cards / kanban).
 *
 * Browser-safe (no Node imports): the server builds the index with it and
 * the editor uses the same functions for autocomplete and live views.
 */

// ─── Paths ──────────────────────────────────────────────────────────────────

export const NOTE_EXT = ".md";
export const BASE_EXT = ".base";
export const ATTACHMENT_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".pdf", ".mp3", ".wav", ".m4a", ".mp4", ".webm", ".mov"] as const;
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp"] as const;

export function extOf(p: string): string {
	const base = basename(p);
	const i = base.lastIndexOf(".");
	return i > 0 ? base.slice(i).toLowerCase() : "";
}
export function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}
export function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(0, i) : "";
}
/** "folder/My note.md" → "My note". */
export function noteTitle(p: string): string {
	const b = basename(p);
	const e = extOf(b);
	return e ? b.slice(0, -e.length) : b;
}
export function isNotePath(p: string): boolean {
	return extOf(p) === NOTE_EXT;
}
export function isImagePath(p: string): boolean {
	return (IMAGE_EXTS as readonly string[]).includes(extOf(p));
}

/** Vault-relative path hygiene: forward slashes, no leading slash, no
 *  "."/".." segments, no hidden segments (".obsidian", ".trash"), no NUL.
 *  Returns null for anything that could escape or touch app internals. */
export function cleanNotePath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const parts = raw.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
	if (parts.length === 0) return null;
	for (const s of parts) {
		if (s === ".." || s.startsWith(".") || s.includes("\0") || /[<>:"|?*]/.test(s) || s.length > 200) return null;
	}
	return parts.join("/");
}

/** Characters Obsidian refuses in note names (they break links). */
export const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;

// ─── Frontmatter (YAML subset) ──────────────────────────────────────────────

export type PropValue = string | number | boolean | null | PropValue[];
export type Props = Record<string, PropValue>;

export interface Frontmatter {
	props: Props;
	/** Note text after the closing fence. */
	body: string;
	/** Character offset of the body in the full text. */
	bodyStart: number;
	/** True when the text opens with a `---` fence that closes. */
	present: boolean;
}

function parseScalar(raw: string): PropValue {
	const v = raw.trim();
	if (v === "" || v === "~" || v === "null") return null;
	if (v === "true") return true;
	if (v === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		const inner = v.slice(1, -1);
		return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
	}
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		if (!inner) return [];
		return splitFlow(inner).map(parseScalar);
	}
	return v;
}

/** Split a YAML flow sequence body on top-level commas (quotes respected). */
function splitFlow(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q: string | null = null;
	let depth = 0;
	for (const ch of s) {
		if (q) {
			cur += ch;
			if (ch === q) q = null;
		} else if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
		} else if (ch === "[") {
			depth++;
			cur += ch;
		} else if (ch === "]") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out;
}

export function parseYamlProps(yaml: string): Props {
	const props: Props = {};
	const lines = yaml.split(/\r?\n/);
	let key: string | null = null;
	for (const line of lines) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const item = /^\s+-\s*(.*)$|^-\s+(.*)$/.exec(line);
		if (item && key) {
			const cur = props[key];
			const arr = Array.isArray(cur) ? cur : [];
			arr.push(parseScalar(item[1] ?? item[2] ?? ""));
			props[key] = arr;
			continue;
		}
		const kv = /^([^\s:#][^:]*?)\s*:(?:\s+(.*)|\s*)$/.exec(line);
		if (kv) {
			key = kv[1]!.trim();
			const rest = kv[2];
			props[key] = rest === undefined || rest.trim() === "" ? null : parseScalar(rest);
		}
	}
	return props;
}

export function parseFrontmatter(text: string): Frontmatter {
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) {
		// An empty frontmatter block: ---\n---
		const empty = /^---\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
		if (empty) return { props: {}, body: text.slice(empty[0].length), bodyStart: empty[0].length, present: true };
		return { props: {}, body: text, bodyStart: 0, present: false };
	}
	return { props: parseYamlProps(m[1]!), body: text.slice(m[0].length), bodyStart: m[0].length, present: true };
}

function yamlScalar(v: PropValue): string {
	if (v === null) return "";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return `[${v.map(yamlScalar).join(", ")}]`;
	const s = String(v);
	if (s === "" || /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|~|-?\d+(\.\d+)?)$|\n|\s$/.test(s)) {
		return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	}
	return s;
}

export function stringifyProps(props: Props): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(props)) {
		if (Array.isArray(v)) {
			if (v.length === 0) lines.push(`${k}: []`);
			else {
				lines.push(`${k}:`);
				for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
			}
		} else lines.push(v === null ? `${k}:` : `${k}: ${yamlScalar(v)}`);
	}
	return lines.join("\n");
}

/** Replace (or add, or remove when empty) the note's frontmatter block. */
export function withProps(text: string, props: Props): string {
	const fm = parseFrontmatter(text);
	const body = fm.present ? fm.body : text;
	if (Object.keys(props).length === 0) return body;
	return `---\n${stringifyProps(props)}\n---\n${body}`;
}

// ─── Inline syntax ──────────────────────────────────────────────────────────

export interface WikiLink {
	/** Raw target before #/^/| ("folder/Note"). */
	target: string;
	/** Heading ("#Heading") or block ("^id") subpath, without the marker. */
	heading?: string;
	block?: string;
	alias?: string;
	embed: boolean;
	/** Offsets in the scanned text. */
	from: number;
	to: number;
}

/** Mask fenced code, inline code and math so links/tags inside them are
 *  ignored. Same length as the input (offsets survive). */
export function maskCode(text: string): string {
	let out = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|$)/gm, (m) => m.replace(/[^\n]/g, " "));
	out = out.replace(/\$\$[\s\S]*?\$\$/g, (m) => m.replace(/[^\n]/g, " "));
	out = out.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
	out = out.replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, " "));
	return out;
}

const WIKI_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

export function parseWikiInner(inner: string): Pick<WikiLink, "target" | "heading" | "block" | "alias"> {
	let rest = inner;
	let alias: string | undefined;
	const bar = rest.indexOf("|");
	if (bar >= 0) {
		alias = rest.slice(bar + 1).trim() || undefined;
		rest = rest.slice(0, bar);
	}
	let heading: string | undefined;
	let block: string | undefined;
	const hash = rest.indexOf("#");
	if (hash >= 0) {
		const sub = rest.slice(hash + 1).trim();
		rest = rest.slice(0, hash);
		if (sub.startsWith("^")) block = sub.slice(1);
		else if (sub) heading = sub;
	}
	return { target: rest.trim(), heading, block, alias };
}

export function extractWikiLinks(text: string): WikiLink[] {
	const masked = maskCode(text);
	const out: WikiLink[] = [];
	for (const m of masked.matchAll(WIKI_RE)) {
		const inner = text.slice(m.index! + m[1]!.length + 2, m.index! + m[0].length - 2);
		out.push({ ...parseWikiInner(inner), embed: m[1] === "!", from: m.index!, to: m.index! + m[0].length });
	}
	return out;
}

/** Markdown links to local notes: [text](Some%20Note.md). */
export function extractMdLinks(text: string): { target: string; heading?: string; from: number; to: number }[] {
	const masked = maskCode(text);
	const out: { target: string; heading?: string; from: number; to: number }[] = [];
	for (const m of masked.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		const href = text.slice(m.index!, m.index! + m[0].length).match(/\]\(([^)\s]+)/)![1]!;
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) continue;
		let decoded = href;
		try {
			decoded = decodeURIComponent(href);
		} catch {
			/* keep raw */
		}
		const [target, heading] = decoded.split("#");
		if (!target) continue;
		out.push({ target, heading, from: m.index!, to: m.index! + m[0].length });
	}
	return out;
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export function extractInlineTags(text: string): string[] {
	const masked = maskCode(text)
		// Headings' leading hashes and URL fragments are not tags.
		.replace(/^#{1,6}\s/gm, (m) => " ".repeat(m.length))
		.replace(/\]\([^)]*\)/g, (m) => " ".repeat(m.length))
		.replace(/\[\[[^\]]*\]\]/g, (m) => " ".repeat(m.length));
	const out: string[] = [];
	for (const m of masked.matchAll(TAG_RE)) out.push(m[2]!);
	return out;
}

function propList(v: PropValue | undefined): string[] {
	if (v === undefined || v === null) return [];
	if (Array.isArray(v)) return v.flatMap((x) => propList(x));
	return String(v)
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function noteTags(props: Props, body: string): string[] {
	const fmTags = [...propList(props.tags), ...propList(props.tag)].map((t) => t.replace(/^#/, ""));
	const set = new Map<string, string>();
	for (const t of [...fmTags, ...extractInlineTags(body)]) {
		const k = t.toLowerCase();
		if (!set.has(k)) set.set(k, t);
	}
	return [...set.values()];
}

export function noteAliases(props: Props): string[] {
	const v = props.aliases ?? props.alias;
	if (v === undefined || v === null) return [];
	return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter(Boolean);
}

export interface Heading {
	level: number;
	text: string;
	/** Line number (0-based) in the full text. */
	line: number;
}

export function extractHeadings(text: string): Heading[] {
	const masked = maskCode(text);
	const out: Heading[] = [];
	const lines = masked.split("\n");
	const raw = text.split("\n");
	const fm = parseFrontmatter(text);
	const fmLines = fm.present ? text.slice(0, fm.bodyStart).split("\n").length - 1 : 0;
	for (let i = fmLines; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]!);
		if (m) out.push({ level: m[1]!.length, text: raw[i]!.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim(), line: i });
	}
	return out;
}

export interface TaskItem {
	line: number;
	done: boolean;
	text: string;
}

export function extractTasks(text: string): TaskItem[] {
	const masked = maskCode(text).split("\n");
	const raw = text.split("\n");
	const out: TaskItem[] = [];
	masked.forEach((l, i) => {
		const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX\-/])\]\s+(.*)$/.exec(l);
		if (m) out.push({ line: i, done: m[1] !== " ", text: raw[i]!.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s+/, "") });
	});
	return out;
}

const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX\-/])\]/;
const DONE_STAMP = /\s*✅\s*(\d{4}-\d{2}-\d{2})/;

/** The "✅ YYYY-MM-DD" completion date on a task (Obsidian Tasks convention). */
export function taskDoneDate(text: string): string | null {
	return DONE_STAMP.exec(text)?.[1] ?? null;
}

/** Toggle one task line. Checking stamps "✅ today" when `today` is given; unchecking removes the stamp. */
export function toggleTaskText(l: string, today?: string): string {
	const m = TASK_BOX.exec(l);
	if (!m) return l;
	const checking = m[2] === " ";
	const out = l.slice(0, m[1]!.length) + (checking ? "x" : " ") + l.slice(m[1]!.length + 1);
	if (!checking) return out.replace(DONE_STAMP, "");
	if (!today || DONE_STAMP.test(out)) return out;
	const blockId = /\s\^[A-Za-z0-9-]+\s*$/.exec(out);
	const at = blockId ? blockId.index : out.trimEnd().length;
	return `${out.slice(0, at).trimEnd()} ✅ ${today}${out.slice(at)}`;
}

/** Toggle the checkbox on a given line. */
export function toggleTaskLine(text: string, line: number, today?: string): string {
	const lines = text.split("\n");
	const l = lines[line];
	if (l === undefined) return text;
	lines[line] = toggleTaskText(l, today);
	return lines.join("\n");
}

/** Block ids: a trailing "^id" on a paragraph line. */
export function extractBlockIds(text: string): { id: string; line: number }[] {
	const out: { id: string; line: number }[] = [];
	maskCode(text)
		.split("\n")
		.forEach((l, i) => {
			const m = /\s\^([A-Za-z0-9-]+)\s*$/.exec(l);
			if (m) out.push({ id: m[1]!, line: i });
		});
	return out;
}

/** The section under a heading (until the next heading of the same or a
 *  higher level), or the paragraph carrying a block id. */
export function extractSection(text: string, sub: { heading?: string; block?: string }): string | null {
	const lines = text.split("\n");
	if (sub.heading) {
		const want = slugHeading(sub.heading);
		const hs = extractHeadings(text);
		const i = hs.findIndex((h) => slugHeading(h.text) === want);
		if (i < 0) return null;
		const h = hs[i]!;
		const next = hs.slice(i + 1).find((x) => x.level <= h.level);
		return lines.slice(h.line, next ? next.line : lines.length).join("\n").trim();
	}
	if (sub.block) {
		const b = extractBlockIds(text).find((x) => x.id === sub.block);
		if (!b) return null;
		let start = b.line;
		while (start > 0 && lines[start - 1]!.trim() !== "" && !/^#{1,6}\s/.test(lines[start - 1]!)) start--;
		return lines
			.slice(start, b.line + 1)
			.join("\n")
			.replace(/\s\^[A-Za-z0-9-]+\s*$/, "")
			.trim();
	}
	return null;
}

export function slugHeading(h: string): string {
	return h
		.toLowerCase()
		.replace(/[[\]#^|*_`~=]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Word count over the visible prose (frontmatter, code and markup stripped). */
export function wordCount(text: string): number {
	const body = maskCode(parseFrontmatter(text).body).replace(/[#>*_`~=[\]()!|-]/g, " ");
	const m = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu);
	return m ? m.length : 0;
}

// ─── Index ──────────────────────────────────────────────────────────────────

export interface NoteMeta {
	path: string;
	title: string;
	folder: string;
	size: number;
	mtime: number;
	ctime: number;
	props: Props;
	tags: string[];
	aliases: string[];
	headings: Heading[];
	/** Outgoing links, resolved where possible (path) — unresolved keep the raw target. */
	links: { target: string; path: string | null; heading?: string; block?: string; embed: boolean }[];
	tasks: { total: number; done: number };
	words: number;
}

export interface VaultFile {
	path: string;
	size: number;
	mtime: number;
	ctime: number;
}

export interface VaultIndex {
	notes: NoteMeta[];
	/** Every file in the vault (notes, bases, attachments). */
	files: VaultFile[];
	folders: string[];
	/** path → paths of notes linking to it. */
	backlinks: Record<string, string[]>;
	/** tag (lower-case) → { display, count }. */
	tags: Record<string, { tag: string; count: number }>;
	/** Unresolved link targets → linking notes (Obsidian's "unresolved"). */
	unresolved: Record<string, string[]>;
}

/** Obsidian-style link resolution: exact vault path (with or without
 *  extension), then relative to the linking note's folder, then the
 *  shortest path whose file name matches, then a note alias. */
export class LinkResolver {
	private byPath = new Map<string, string>();
	private byName = new Map<string, string[]>();
	private byAlias = new Map<string, string>();

	constructor(files: readonly { path: string }[], aliases: readonly { path: string; aliases: string[] }[] = []) {
		for (const f of files) {
			const lower = f.path.toLowerCase();
			this.byPath.set(lower, f.path);
			if (isNotePath(f.path)) this.byPath.set(lower.slice(0, -NOTE_EXT.length), f.path);
			for (const key of [basename(f.path).toLowerCase(), isNotePath(f.path) ? noteTitle(f.path).toLowerCase() : null]) {
				if (!key) continue;
				const list = this.byName.get(key) ?? [];
				list.push(f.path);
				this.byName.set(key, list);
			}
		}
		for (const list of this.byName.values()) list.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length || a.localeCompare(b));
		for (const a of aliases) for (const al of a.aliases) if (!this.byAlias.has(al.toLowerCase())) this.byAlias.set(al.toLowerCase(), a.path);
	}

	resolve(target: string, from?: string): string | null {
		const t = target.trim().replace(/^\.\//, "");
		if (!t) return from ?? null;
		const lower = t.toLowerCase();
		const exact = this.byPath.get(lower);
		if (exact) return exact;
		if (from) {
			const rel = joinRel(dirname(from), t).toLowerCase();
			const r = this.byPath.get(rel) ?? this.byPath.get(rel.replace(/\.md$/, ""));
			if (r) return r;
		}
		if (!t.includes("/")) {
			const byName = this.byName.get(lower);
			if (byName?.length) return byName[0]!;
		} else {
			// Partial path: match the suffix.
			const suffix = "/" + lower.replace(/\.md$/, "");
			for (const [k, v] of this.byPath) if (k.endsWith(suffix) && (isNotePath(v) ? !k.endsWith(".md") : true)) return v;
		}
		return this.byAlias.get(lower) ?? null;
	}

	/** The shortest link text that resolves uniquely to `path`
	 *  (Obsidian's "shortest path when possible"). */
	linkText(path: string): string {
		const name = isNotePath(path) ? noteTitle(path) : basename(path);
		const same = this.byName.get(name.toLowerCase()) ?? [];
		if (same.length <= 1 || same[0] === path) return name;
		return isNotePath(path) ? path.slice(0, -NOTE_EXT.length) : path;
	}
}

function joinRel(dir: string, rel: string): string {
	const parts = dir ? dir.split("/") : [];
	for (const seg of rel.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

export function analyzeNote(file: VaultFile, text: string): Omit<NoteMeta, "links"> & { rawLinks: { target: string; heading?: string; block?: string; embed: boolean }[] } {
	const fm = parseFrontmatter(text);
	const wl = extractWikiLinks(text).map((l) => ({ target: l.target, heading: l.heading, block: l.block, embed: l.embed }));
	const ml = extractMdLinks(fm.body).map((l) => ({ target: l.target, heading: l.heading, embed: false }));
	// Frontmatter values like "[[Other]]" are links too (Obsidian properties).
	const fmLinks: { target: string; embed: boolean }[] = [];
	const walk = (v: PropValue) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (typeof v === "string") for (const m of v.matchAll(/\[\[([^\]]+)\]\]/g)) fmLinks.push({ target: parseWikiInner(m[1]!).target, embed: false });
	};
	Object.values(fm.props).forEach(walk);
	const tasks = extractTasks(text);
	return {
		path: file.path,
		title: noteTitle(file.path),
		folder: dirname(file.path),
		size: file.size,
		mtime: file.mtime,
		ctime: file.ctime,
		props: fm.props,
		tags: noteTags(fm.props, fm.body),
		aliases: noteAliases(fm.props),
		headings: extractHeadings(text),
		rawLinks: [...wl.filter((l) => l.target || l.heading || l.block), ...ml, ...fmLinks],
		tasks: { total: tasks.length, done: tasks.filter((t) => t.done).length },
		words: wordCount(text),
	};
}

export function buildIndex(files: readonly VaultFile[], read: (path: string) => string | null): VaultIndex {
	const analyzed = files
		.filter((f) => isNotePath(f.path))
		.map((f) => {
			const text = read(f.path);
			return text === null ? null : analyzeNote(f, text);
		})
		.filter((x): x is NonNullable<typeof x> => x !== null);
	const resolver = new LinkResolver(files, analyzed);
	const backlinks: Record<string, string[]> = {};
	const unresolved: Record<string, string[]> = {};
	const tags: Record<string, { tag: string; count: number }> = {};
	const notes: NoteMeta[] = analyzed.map(({ rawLinks, ...n }) => {
		const links = rawLinks.map((l) => {
			const path = l.target ? resolver.resolve(l.target, n.path) : n.path;
			return { ...l, path };
		});
		for (const l of links) {
			if (l.path) {
				if (l.path === n.path) continue;
				const list = (backlinks[l.path] ??= []);
				if (!list.includes(n.path)) list.push(n.path);
			} else if (l.target) {
				const key = l.target;
				const list = (unresolved[key] ??= []);
				if (!list.includes(n.path)) list.push(n.path);
			}
		}
		for (const t of n.tags) {
			// Nested tags count toward every ancestor (#a/b → a, a/b).
			const parts = t.split("/");
			for (let i = 1; i <= parts.length; i++) {
				const sub = parts.slice(0, i).join("/");
				const k = sub.toLowerCase();
				tags[k] = { tag: tags[k]?.tag ?? sub, count: (tags[k]?.count ?? 0) + 1 };
			}
		}
		return { ...n, links };
	});
	const folders = new Set<string>();
	for (const f of files) {
		let d = dirname(f.path);
		while (d) {
			folders.add(d);
			d = dirname(d);
		}
	}
	return { notes, files: [...files], folders: [...folders].sort(), backlinks, tags, unresolved };
}

/**
 * Outgoing note-to-note links plus unresolved wikilink targets.
 * Attachments and self-links are not relations between notes.
 * The graph turns related-edges on by itself while this is under
 * {@link RELATED_EDGES_AUTO_MAX_LINKS}.
 */
export function noteLinkCount(notes: readonly NoteMeta[]): number {
	let n = 0;
	for (const note of notes) {
		for (const l of note.links) {
			if (l.path === note.path) continue;
			if (l.path === null) {
				if (l.target) n++;
				continue;
			}
			if (isNotePath(l.path)) n++;
		}
	}
	return n;
}

// ─── Mentions, rename ───────────────────────────────────────────────────────

/** Notes that mention `title` (or an alias) in plain text without linking it. */
export function unlinkedMentions(
	title: string,
	aliases: readonly string[],
	notes: readonly { path: string; text: string }[],
	self: string,
): { path: string; line: number; snippet: string }[] {
	const names = [title, ...aliases].filter((n) => n.length >= 3);
	if (!names.length) return [];
	const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
	const out: { path: string; line: number; snippet: string }[] = [];
	for (const n of notes) {
		if (n.path === self) continue;
		const masked = maskCode(parseFrontmatter(n.text).present ? n.text.replace(/^---[\s\S]*?\n---/, (m) => m.replace(/[^\n]/g, " ")) : n.text)
			.replace(/!?\[\[[^\]]*\]\]/g, (m) => " ".repeat(m.length))
			.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length));
		const lines = masked.split("\n");
		const raw = n.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (re.test(lines[i]!)) {
				out.push({ path: n.path, line: i, snippet: raw[i]!.trim().slice(0, 200) });
				break;
			}
		}
	}
	return out;
}

export function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Related notes (no model, no network) ──────────────────────────────────

export interface RelatedHit {
	path: string;
	/** Cosine similarity in [0, 1]. */
	score: number;
}

export interface RelatedEdge {
	source: string;
	target: string;
	score: number;
}

/** Dashed graph edges at or above this cosine. */
export const RELATED_EDGE_THRESHOLD = 0.15;

/** Related edges default on while the vault has fewer links than this. */
export const RELATED_EDGES_AUTO_MAX_LINKS = 10;

const RELATED_STOP = new Set(
	"a an the and or but if then else of to in on for with at by from as is are was were be been being it this that these those i you we they he she my your our their not no do does did have has had will can could should would about into over after before than so just also its via per vs too very more most other some such only own same out up down off when what which who how why".split(
		" ",
	),
);

export interface RelatedDoc {
	path: string;
	title: string;
	text: string;
}

interface TermVec {
	path: string;
	weights: Map<string, number>;
	norm: number;
}

/** Fold a trailing plural s so "eigenvector" and "eigenvectors" meet. Not a stemmer. */
function foldTerm(t: string): string {
	if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
	return t;
}

function addTerms(raw: string, weight: number, into: Map<string, number>) {
	const han: string[] = [];
	const latin = raw.replace(/\p{Script=Han}+/gu, (run) => {
		han.push(run);
		return " ";
	});
	for (const run of han) {
		if (run.length === 1) into.set(run, (into.get(run) ?? 0) + weight);
		else
			for (let i = 0; i < run.length - 1; i++) {
				const g = run.slice(i, i + 2);
				into.set(g, (into.get(g) ?? 0) + weight);
			}
	}
	for (const m of latin.toLowerCase().matchAll(/[a-z0-9][a-z0-9'-]{1,}/g)) {
		const t = foldTerm(m[0]);
		if (RELATED_STOP.has(t) || /^\d+$/.test(t)) continue;
		into.set(t, (into.get(t) ?? 0) + weight);
	}
}

/** Title tokens count three times. Code fences and frontmatter do not count. */
export function termCounts(title: string, text: string): Map<string, number> {
	const counts = new Map<string, number>();
	addTerms(title, 3, counts);
	addTerms(maskCode(parseFrontmatter(text).body), 1, counts);
	return counts;
}

function buildVectors(docs: readonly RelatedDoc[]): TermVec[] {
	const tfs = docs.map((d) => ({ path: d.path, tf: termCounts(d.title, d.text) }));
	const df = new Map<string, number>();
	for (const d of tfs) for (const term of d.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
	const n = Math.max(docs.length, 1);
	return tfs.map((d) => {
		const weights = new Map<string, number>();
		let sumSq = 0;
		for (const [term, tf] of d.tf) {
			const idf = Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1;
			const w = (1 + Math.log(tf)) * idf;
			weights.set(term, w);
			sumSq += w * w;
		}
		return { path: d.path, weights, norm: Math.sqrt(sumSq) };
	});
}

function cosine(a: TermVec, b: TermVec): number {
	if (a.norm === 0 || b.norm === 0) return 0;
	const [small, large] = a.weights.size < b.weights.size ? [a, b] : [b, a];
	let dot = 0;
	for (const [term, w] of small.weights) {
		const other = large.weights.get(term);
		if (other) dot += w * other;
	}
	return dot / (a.norm * b.norm);
}

function roundScore(score: number): number {
	return Math.round(score * 1000) / 1000;
}

function topFromVectors(vecs: readonly TermVec[], self: string, limit: number): RelatedHit[] {
	const me = vecs.find((v) => v.path === self);
	if (!me) return [];
	return vecs
		.filter((v) => v.path !== self)
		.map((v) => ({ path: v.path, score: cosine(me, v) }))
		.filter((h) => h.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit)
		.map((h) => ({ path: h.path, score: roundScore(h.score) }));
}

function edgesFromScores(vecs: readonly TermVec[], scored: readonly { a: number; b: number; score: number }[], perNode: number): RelatedEdge[] {
	const kept = vecs.map(() => 0);
	const edges: RelatedEdge[] = [];
	const ordered = [...scored].sort((x, y) => y.score - x.score || vecs[x.a]!.path.localeCompare(vecs[y.a]!.path) || vecs[x.b]!.path.localeCompare(vecs[y.b]!.path));
	for (const s of ordered) {
		// Highest scores first, so a full node keeps its closest notes.
		if (kept[s.a]! >= perNode || kept[s.b]! >= perNode) continue;
		kept[s.a] = kept[s.a]! + 1;
		kept[s.b] = kept[s.b]! + 1;
		const pa = vecs[s.a]!.path;
		const pb = vecs[s.b]!.path;
		const source = pa < pb ? pa : pb;
		const target = pa < pb ? pb : pa;
		edges.push({ source, target, score: roundScore(s.score) });
	}
	return edges;
}

/** Vaults up to this size compare every pair. Larger vaults only compare notes that share an uncommon word. */
const RELATED_ALL_PAIRS_MAX = 160;

function edgesFromVectors(vecs: readonly TermVec[], threshold: number, perNode = 4): RelatedEdge[] {
	const n = vecs.length;
	const scored: { a: number; b: number; score: number }[] = [];
	const push = (a: number, b: number) => {
		const score = cosine(vecs[a]!, vecs[b]!);
		if (score >= threshold) scored.push({ a, b, score });
	};
	if (n <= RELATED_ALL_PAIRS_MAX) {
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) push(i, j);
		return edgesFromScores(vecs, scored, perNode);
	}
	const postings = new Map<string, number[]>();
	vecs.forEach((v, i) => {
		for (const term of v.weights.keys()) {
			const list = postings.get(term);
			if (list) list.push(i);
			else postings.set(term, [i]);
		}
	});
	const cand = vecs.map(() => new Map<number, number>());
	for (const ids of postings.values()) {
		const df = ids.length;
		if (df < 2 || df > 50) continue;
		const rarity = 1 / df;
		for (let a = 0; a < df; a++) {
			for (let b = a + 1; b < df; b++) {
				const ia = ids[a]!;
				const ib = ids[b]!;
				cand[ia]!.set(ib, (cand[ia]!.get(ib) ?? 0) + rarity);
				cand[ib]!.set(ia, (cand[ib]!.get(ia) ?? 0) + rarity);
			}
		}
	}
	const pairs = new Map<string, [number, number]>();
	for (let i = 0; i < n; i++) {
		const row = [...cand[i]!.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
		for (const [j] of row) {
			const lo = Math.min(i, j);
			const hi = Math.max(i, j);
			pairs.set(`${lo}:${hi}`, [lo, hi]);
		}
	}
	for (const [a, b] of pairs.values()) push(a, b);
	return edgesFromScores(vecs, scored, perNode);
}

/** Other notes ranked by TF-IDF cosine over the title (×3) and the body. */
export function rankRelated(self: string, docs: readonly RelatedDoc[], limit = 5): RelatedHit[] {
	return topFromVectors(buildVectors(docs), self, limit);
}

/** Undirected pairs similar enough to draw as dashed graph edges. */
export function relatedEdges(docs: readonly RelatedDoc[], threshold = RELATED_EDGE_THRESHOLD): RelatedEdge[] {
	return edgesFromVectors(buildVectors(docs), threshold);
}

/** One vector build for both the panel (per note) and the dashed edges. */
export function relateVault(docs: readonly RelatedDoc[], threshold = RELATED_EDGE_THRESHOLD): { edges: RelatedEdge[]; rank: (path: string, limit?: number) => RelatedHit[] } {
	const vecs = buildVectors(docs);
	return { edges: edgesFromVectors(vecs, threshold), rank: (path, limit = 5) => topFromVectors(vecs, path, limit) };
}

function findRelatedHeading(lines: readonly string[]): number {
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const opened = /^(```|~~~)/.exec(line);
		if (opened) {
			if (fence === null) fence = opened[1]!;
			else if (line.startsWith(fence)) fence = null;
			continue;
		}
		if (!fence && /^##\s+Related\s*$/i.test(line)) return i;
	}
	return -1;
}

/**
 * Append `[[target]]` under a "## Related" heading, creating the heading
 * at the end when the note doesn't have one. A link already in that
 * section (including an alias or heading) is left as-is.
 */
export function appendRelatedLink(text: string, target: string): string {
	const label = target.trim();
	if (!label || /[\]\n]/.test(label)) return text;
	const link = `[[${label}]]`;
	const lines = text.split("\n");
	const heading = findRelatedHeading(lines);
	if (heading >= 0) {
		let end = lines.length;
		let fence: string | null = null;
		for (let i = heading + 1; i < lines.length; i++) {
			const line = lines[i]!;
			const opened = /^(```|~~~)/.exec(line);
			if (opened) {
				if (fence === null) fence = opened[1]!;
				else if (line.startsWith(fence)) fence = null;
				continue;
			}
			if (!fence && /^#{1,2}\s+\S/.test(line)) {
				end = i;
				break;
			}
		}
		const section = lines.slice(heading, end).join("\n");
		if (new RegExp(`\\[\\[${escapeRe(label)}(?:\\]|#|\\|)`, "i").test(section)) return text;
		let insertAt = end;
		while (insertAt > heading + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
		return [...lines.slice(0, insertAt), link, ...lines.slice(insertAt)].join("\n");
	}
	const trimmed = text.replace(/\s*$/, "");
	const sep = trimmed.length ? "\n\n" : "";
	return `${trimmed}${sep}## Related\n${link}\n`;
}

/** Rewrite links in `text` (a note at `fromPath`) that pointed at `oldPath`
 *  so they point at `newPath`. Aliases, headings and embeds survive. */
export function rewriteLinks(
	text: string,
	fromPath: string,
	oldPath: string,
	newPath: string,
	before: LinkResolver,
	after: LinkResolver,
): string {
	let out = "";
	let last = 0;
	for (const l of extractWikiLinks(text)) {
		if (!l.target) continue;
		if (before.resolve(l.target, fromPath) !== oldPath) continue;
		const keepExt = !isNotePath(newPath) || /\.md$/i.test(l.target);
		let target = after.linkText(newPath);
		if (keepExt && isNotePath(newPath) && !target.endsWith(NOTE_EXT)) target += NOTE_EXT;
		const sub = l.heading ? `#${l.heading}` : l.block ? `#^${l.block}` : "";
		const alias = l.alias ? `|${l.alias}` : "";
		out += text.slice(last, l.from) + `${l.embed ? "!" : ""}[[${target}${sub}${alias}]]`;
		last = l.to;
	}
	out += text.slice(last);
	// Markdown links: [x](Old%20Name.md)
	return out.replace(/(!?\[[^\]\n]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (m, a: string, href: string, b: string) => {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return m;
		let decoded = href;
		try {
			decoded = decodeURIComponent(href);
		} catch {
			return m;
		}
		const [target, heading] = decoded.split("#");
		if (!target || before.resolve(target, fromPath) !== oldPath) return m;
		const rel = relativePath(dirname(fromPath), newPath);
		return `${a}${encodeURI(rel)}${heading ? "#" + encodeURIComponent(heading) : ""}${b}`;
	});
}

export function relativePath(fromDir: string, to: string): string {
	const a = fromDir ? fromDir.split("/") : [];
	const b = to.split("/");
	let i = 0;
	while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchQuery {
	terms: string[];
	phrases: string[];
	exclude: string[];
	tags: string[];
	paths: string[];
	files: string[];
	tasks: "todo" | "done" | "any" | null;
	props: { key: string; value: string | null }[];
	regex: RegExp | null;
}

/** Obsidian search operators: tag:#x  path:folder  file:name  "exact phrase"
 *  -exclude  [prop:value]  task-todo: task-done:  /regex/ */
export function parseSearch(q: string): SearchQuery {
	const out: SearchQuery = { terms: [], phrases: [], exclude: [], tags: [], paths: [], files: [], tasks: null, props: [], regex: null };
	const re = /(-?)(?:(tag|path|file|task|task-todo|task-done):)?(?:"([^"]*)"|\[([^\]:]+)(?::([^\]]*))?\]|\/((?:\\.|[^/])+)\/|(\S+))?/g;
	for (const m of q.matchAll(re)) {
		const [, neg, op, phrase, propKey, propVal, rx, word] = m;
		if (!op && phrase === undefined && propKey === undefined && rx === undefined && word === undefined) continue;
		const val = (phrase ?? word ?? "").trim();
		if (propKey) {
			out.props.push({ key: propKey.trim(), value: propVal === undefined ? null : propVal.trim() });
			continue;
		}
		if (rx) {
			try {
				out.regex = new RegExp(rx, "i");
			} catch {
				/* ignore invalid */
			}
			continue;
		}
		if (op === "tag") out.tags.push(val.replace(/^#/, "").toLowerCase());
		else if (op === "path") out.paths.push(val.toLowerCase());
		else if (op === "file") out.files.push(val.toLowerCase());
		else if (op === "task" || op === "task-todo" || op === "task-done") {
			out.tasks = op === "task-todo" ? "todo" : op === "task-done" ? "done" : "any";
			if (val) out.terms.push(val.toLowerCase());
		} else if (neg) out.exclude.push(val.toLowerCase());
		else if (phrase !== undefined) out.phrases.push(val.toLowerCase());
		else if (val.startsWith("#") && val.length > 1) out.tags.push(val.slice(1).toLowerCase());
		else if (val) out.terms.push(val.toLowerCase());
	}
	return out;
}

export interface SearchHit {
	path: string;
	title: string;
	score: number;
	matches: { line: number; text: string; ranges: [number, number][] }[];
}

export function searchNotes(
	q: string,
	notes: readonly { meta: NoteMeta; text: string }[],
	limit = 200,
): SearchHit[] {
	const sq = parseSearch(q);
	const hits: SearchHit[] = [];
	const lineTerms = [...sq.terms, ...sq.phrases];
	for (const { meta, text } of notes) {
		const lower = text.toLowerCase();
		const pathLower = meta.path.toLowerCase();
		if (sq.tags.length && !sq.tags.every((t) => meta.tags.some((mt) => mt.toLowerCase() === t || mt.toLowerCase().startsWith(t + "/")))) continue;
		if (sq.paths.length && !sq.paths.every((p) => pathLower.includes(p))) continue;
		if (sq.files.length && !sq.files.every((f) => meta.title.toLowerCase().includes(f))) continue;
		if (sq.exclude.some((e) => lower.includes(e) || pathLower.includes(e))) continue;
		if (sq.props.length && !sq.props.every(({ key, value }) => {
			const v = propValue(meta, key);
			if (value === null) return v !== undefined && v !== null && v !== "";
			return propToText(v).toLowerCase().includes(value.toLowerCase());
		})) continue;
		const titleLower = meta.title.toLowerCase();
		const everyTerm = lineTerms.every((t) => lower.includes(t) || titleLower.includes(t) || meta.aliases.some((a) => a.toLowerCase().includes(t)));
		if (!everyTerm) continue;
		if (sq.regex && !sq.regex.test(text)) continue;
		const lines = text.split("\n");
		const matches: SearchHit["matches"] = [];
		const taskLines = sq.tasks ? new Map(extractTasks(text).map((t) => [t.line, t])) : null;
		lines.forEach((line, i) => {
			if (matches.length >= 8) return;
			if (taskLines) {
				const t = taskLines.get(i);
				if (!t || (sq.tasks === "todo" && t.done) || (sq.tasks === "done" && !t.done)) return;
			}
			const ll = line.toLowerCase();
			const ranges: [number, number][] = [];
			for (const t of lineTerms) {
				let at = ll.indexOf(t);
				while (at >= 0 && t) {
					ranges.push([at, at + t.length]);
					at = ll.indexOf(t, at + t.length);
				}
			}
			if (sq.regex) {
				const m = sq.regex.exec(line);
				if (m) ranges.push([m.index, m.index + m[0].length]);
			}
			if (ranges.length || (taskLines && !lineTerms.length)) matches.push({ line: i, text: line.slice(0, 300), ranges: ranges.sort((a, b) => a[0] - b[0]) });
		});
		if (taskLines && !matches.length) continue;
		let score = 0;
		for (const t of lineTerms) {
			if (titleLower === t) score += 100;
			else if (titleLower.includes(t)) score += 30;
			score += Math.min(10, lower.split(t).length - 1);
		}
		if (!lineTerms.length) score = meta.mtime / 1e13;
		hits.push({ path: meta.path, title: meta.title, score, matches });
	}
	return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/** Fuzzy subsequence score for the quick switcher (higher is better; -1 = no match). */
export function fuzzyMatch(query: string, target: string): number {
	const q = query.toLowerCase().trim();
	const t = target.toLowerCase();
	if (!q) return 0;
	const direct = t.indexOf(q);
	if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 ? 200 : 0);
	let score = 0;
	let ti = 0;
	let streak = 0;
	for (const ch of q) {
		if (ch === " ") continue;
		const at = t.indexOf(ch, ti);
		if (at < 0) return -1;
		streak = at === ti ? streak + 1 : 0;
		score += 10 + streak * 5 - Math.min(at - ti, 10);
		if (at === 0 || /[\s/_-]/.test(t[at - 1]!)) score += 8;
		ti = at + 1;
	}
	return score - t.length * 0.05;
}

// ─── Bases ──────────────────────────────────────────────────────────────────

export type BaseViewType = "table" | "cards" | "kanban";
export type FilterOp = "is" | "is-not" | "contains" | "not-contains" | "starts-with" | "exists" | "missing" | "gt" | "lt" | "has-tag" | "in-folder" | "links-to";

export interface BaseFilter {
	prop: string;
	op: FilterOp;
	value?: string;
}

export interface BaseView {
	name: string;
	type: BaseViewType;
	/** Columns / card fields, in order ("file.name", "status", …). */
	columns: string[];
	filters: BaseFilter[];
	/** "all" (AND) or "any" (OR) over the view's filters. */
	match?: "all" | "any";
	sort?: { prop: string; dir: "asc" | "desc" }[];
	groupBy?: string;
	/** Group order / hidden groups (Obsidian 1.14's Group menu). */
	groupOrder?: string[];
	hiddenGroups?: string[];
	/** Card cover property (an image path or URL). */
	cover?: string;
	limit?: number;
}

export interface BaseConfig {
	/** Base-wide filters applied before every view's own. */
	filters: BaseFilter[];
	match?: "all" | "any";
	/** Computed columns: name → expression (see evalFormula). */
	formulas?: Record<string, string>;
	views: BaseView[];
}

export const FILE_PROPS = ["file.name", "file.path", "file.folder", "file.ext", "file.size", "file.mtime", "file.ctime", "file.tags", "file.links", "file.backlinks", "file.words", "file.tasks"] as const;

export function defaultBase(): BaseConfig {
	return {
		filters: [],
		views: [{ name: "Table", type: "table", columns: ["file.name", "file.tags", "file.mtime"], filters: [], sort: [{ prop: "file.mtime", dir: "desc" }] }],
	};
}

/** .base files are YAML in Obsidian; Meander writes JSON (which is valid
 *  YAML) and reads either its own JSON or falls back to a default. */
export function parseBase(text: string): BaseConfig {
	try {
		const v = JSON.parse(text) as Partial<BaseConfig>;
		if (!v || typeof v !== "object" || !Array.isArray(v.views) || v.views.length === 0) return defaultBase();
		return {
			filters: Array.isArray(v.filters) ? v.filters : [],
			match: v.match === "any" ? "any" : "all",
			formulas: v.formulas && typeof v.formulas === "object" ? v.formulas : {},
			views: v.views.map((view) => ({
				name: String(view.name ?? "View"),
				type: view.type === "cards" || view.type === "kanban" ? view.type : "table",
				columns: Array.isArray(view.columns) ? view.columns.map(String) : ["file.name"],
				filters: Array.isArray(view.filters) ? view.filters : [],
				match: view.match === "any" ? "any" : "all",
				sort: Array.isArray(view.sort) ? view.sort : [],
				groupBy: typeof view.groupBy === "string" ? view.groupBy : undefined,
				groupOrder: Array.isArray(view.groupOrder) ? view.groupOrder.map(String) : undefined,
				hiddenGroups: Array.isArray(view.hiddenGroups) ? view.hiddenGroups.map(String) : undefined,
				cover: typeof view.cover === "string" ? view.cover : undefined,
				limit: typeof view.limit === "number" ? view.limit : undefined,
			})),
		};
	} catch {
		return defaultBase();
	}
}

export function stringifyBase(cfg: BaseConfig): string {
	return JSON.stringify(cfg, null, 2) + "\n";
}

export interface BaseContext {
	backlinks: Record<string, string[]>;
	formulas?: Record<string, string>;
}

/** A note's property value, including the file.* virtual properties. */
export function propValue(meta: NoteMeta, prop: string, ctx?: BaseContext): PropValue | undefined {
	switch (prop) {
		case "file.name":
			return meta.title;
		case "file.path":
			return meta.path;
		case "file.folder":
			return meta.folder;
		case "file.ext":
			return extOf(meta.path).slice(1);
		case "file.size":
			return meta.size;
		case "file.mtime":
			return meta.mtime;
		case "file.ctime":
			return meta.ctime;
		case "file.tags":
			return meta.tags;
		case "file.links":
			return meta.links.filter((l) => l.path).map((l) => noteTitle(l.path!));
		case "file.backlinks":
			return (ctx?.backlinks[meta.path] ?? []).map(noteTitle);
		case "file.words":
			return meta.words;
		case "file.tasks":
			return meta.tasks.total ? `${meta.tasks.done}/${meta.tasks.total}` : null;
	}
	if (prop.startsWith("formula.") && ctx?.formulas) {
		const expr = ctx.formulas[prop.slice("formula.".length)];
		return expr === undefined ? undefined : evalFormula(expr, meta, ctx);
	}
	const key = prop.startsWith("note.") ? prop.slice(5) : prop;
	if (key in meta.props) return meta.props[key];
	const lower = key.toLowerCase();
	for (const k of Object.keys(meta.props)) if (k.toLowerCase() === lower) return meta.props[k];
	return undefined;
}

export function propToText(v: PropValue | undefined): string {
	if (v === undefined || v === null) return "";
	if (Array.isArray(v)) return v.map(propToText).join(", ");
	return String(v);
}

function asNumber(v: PropValue | undefined): number | null {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
		const d = Date.parse(v);
		if (!Number.isNaN(d) && /\d{4}-\d{2}-\d{2}/.test(v)) return d;
	}
	return null;
}

export function matchFilter(meta: NoteMeta, f: BaseFilter, ctx?: BaseContext): boolean {
	const want = (f.value ?? "").trim();
	const wl = want.toLowerCase();
	switch (f.op) {
		case "has-tag":
			return meta.tags.some((t) => t.toLowerCase() === wl.replace(/^#/, "") || t.toLowerCase().startsWith(wl.replace(/^#/, "") + "/"));
		case "in-folder":
			return wl === "" || wl === "/" ? meta.folder === "" : meta.folder.toLowerCase() === wl || meta.folder.toLowerCase().startsWith(wl + "/");
		case "links-to":
			return meta.links.some((l) => (l.path ? noteTitle(l.path).toLowerCase() === wl.replace(/^\[\[|\]\]$/g, "") : false));
	}
	const v = propValue(meta, f.prop, ctx);
	const text = propToText(v).toLowerCase();
	switch (f.op) {
		case "exists":
			return v !== undefined && v !== null && text !== "";
		case "missing":
			return v === undefined || v === null || text === "";
		case "is":
			return Array.isArray(v) ? v.some((x) => propToText(x).toLowerCase() === wl) : text === wl;
		case "is-not":
			return Array.isArray(v) ? !v.some((x) => propToText(x).toLowerCase() === wl) : text !== wl;
		case "contains":
			return text.includes(wl);
		case "not-contains":
			return !text.includes(wl);
		case "starts-with":
			return text.startsWith(wl);
		case "gt":
		case "lt": {
			const a = asNumber(v as PropValue);
			const b = asNumber(want);
			if (a === null || b === null) return false;
			return f.op === "gt" ? a > b : a < b;
		}
	}
	return true;
}

function applyFilters(meta: NoteMeta, filters: readonly BaseFilter[], match: "all" | "any" | undefined, ctx?: BaseContext): boolean {
	if (!filters.length) return true;
	return match === "any" ? filters.some((f) => matchFilter(meta, f, ctx)) : filters.every((f) => matchFilter(meta, f, ctx));
}

export function compareProp(a: PropValue | undefined, b: PropValue | undefined): number {
	const an = asNumber(a as PropValue);
	const bn = asNumber(b as PropValue);
	if (an !== null && bn !== null) return an - bn;
	const as = propToText(a);
	const bs = propToText(b);
	if (!as && bs) return 1;
	if (as && !bs) return -1;
	return as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" });
}

export interface BaseGroup {
	key: string;
	notes: NoteMeta[];
}

export interface BaseResult {
	rows: NoteMeta[];
	groups: BaseGroup[] | null;
	/** Rows matched before `limit` cut them (1.14's result-limit notice). */
	total: number;
}

export function runBaseView(cfg: BaseConfig, view: BaseView, notes: readonly NoteMeta[], ctx: BaseContext, search = ""): BaseResult {
	const c: BaseContext = { ...ctx, formulas: cfg.formulas };
	const s = search.trim().toLowerCase();
	let rows = notes.filter(
		(n) =>
			applyFilters(n, cfg.filters, cfg.match, c) &&
			applyFilters(n, view.filters, view.match, c) &&
			(!s || n.title.toLowerCase().includes(s) || view.columns.some((col) => propToText(propValue(n, col, c)).toLowerCase().includes(s))),
	);
	const sort = view.sort?.length ? view.sort : [{ prop: "file.name", dir: "asc" as const }];
	rows = [...rows].sort((a, b) => {
		for (const s of sort) {
			const d = compareProp(propValue(a, s.prop, c), propValue(b, s.prop, c));
			if (d) return s.dir === "desc" ? -d : d;
		}
		return 0;
	});
	const total = rows.length;
	if (view.limit && view.limit > 0) rows = rows.slice(0, view.limit);
	let groups: BaseGroup[] | null = null;
	const groupBy = view.groupBy ?? (view.type === "kanban" ? "status" : undefined);
	if (groupBy) {
		const map = new Map<string, NoteMeta[]>();
		for (const r of rows) {
			const v = propValue(r, groupBy, c);
			const keys = Array.isArray(v) && v.length ? v.map(propToText) : [propToText(v)];
			for (const k of keys) {
				const list = map.get(k) ?? [];
				list.push(r);
				map.set(k, list);
			}
		}
		const order = view.groupOrder ?? [];
		groups = [...map.entries()]
			.map(([key, notes]) => ({ key, notes }))
			.filter((g) => !view.hiddenGroups?.includes(g.key))
			.sort((a, b) => {
				const ai = order.indexOf(a.key);
				const bi = order.indexOf(b.key);
				if (ai >= 0 || bi >= 0) return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
				if (!a.key) return 1;
				if (!b.key) return -1;
				return a.key.localeCompare(b.key, undefined, { numeric: true });
			});
		// Kanban keeps declared-but-empty columns visible.
		if (view.type === "kanban") for (const k of order) if (!map.has(k) && !view.hiddenGroups?.includes(k)) groups.push({ key: k, notes: [] });
		if (view.type === "kanban" && order.length) groups.sort((a, b) => (order.indexOf(a.key) < 0 ? 1e9 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 1e9 : order.indexOf(b.key)));
	}
	return { rows, groups, total };
}

/** Tiny formula language for computed columns: props by name, numbers,
 *  "strings", + - * / , comparisons, and if(cond, a, b), now(), days(x)
 *  (days since a date), len(x), lower(x), upper(x), concat(a, b, …).
 *  Never evals JS. Errors render as "⚠". */
export function evalFormula(expr: string, meta: NoteMeta, ctx?: BaseContext, depth = 0): PropValue {
	if (depth > 4) return "⚠";
	const toks = tokenizeFormula(expr);
	if (!toks) return "⚠";
	let i = 0;
	const peek = () => toks[i];
	const next = () => toks[i++];
	const val = (v: PropValue | undefined): PropValue => (v === undefined ? null : v);
	const num = (v: PropValue): number => asNumber(v) ?? 0;
	const fns: Record<string, (args: PropValue[]) => PropValue> = {
		if: (a) => (truthy(a[0] ?? null) ? val(a[1]) : val(a[2])),
		now: () => Date.now(),
		days: (a) => {
			const d = asNumber(a[0] ?? null);
			return d === null ? null : Math.floor((Date.now() - d) / 86_400_000);
		},
		len: (a) => (Array.isArray(a[0]) ? a[0].length : propToText(a[0] ?? null).length),
		lower: (a) => propToText(a[0] ?? null).toLowerCase(),
		upper: (a) => propToText(a[0] ?? null).toUpperCase(),
		concat: (a) => a.map((x) => propToText(x)).join(""),
		round: (a) => Math.round(num(a[0] ?? 0) * 10 ** num(a[1] ?? 0)) / 10 ** num(a[1] ?? 0),
		date: (a) => {
			const d = asNumber(a[0] ?? null);
			return d === null ? null : new Date(d).toISOString().slice(0, 10);
		},
	};
	function truthy(v: PropValue): boolean {
		return !(v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && !v.length));
	}
	function primary(): PropValue {
		const t = next();
		if (!t) throw new Error("eof");
		if (t.k === "num") return t.v as number;
		if (t.k === "str") return t.v as string;
		if (t.v === "(") {
			const v = comparison();
			next();
			return v;
		}
		if (t.v === "-") return -num(primary());
		if (t.k === "id") {
			const name = t.v as string;
			if (peek()?.v === "(") {
				next();
				const args: PropValue[] = [];
				while (peek() && peek()!.v !== ")") {
					args.push(comparison());
					if (peek()?.v === ",") next();
				}
				next();
				const fn = fns[name.toLowerCase()];
				if (!fn) throw new Error("fn");
				return fn(args);
			}
			if (name === "true") return true;
			if (name === "false") return false;
			if (name.startsWith("formula.")) {
				const e = ctx?.formulas?.[name.slice(8)];
				return e === undefined ? null : evalFormula(e, meta, ctx, depth + 1);
			}
			return val(propValue(meta, name, ctx));
		}
		throw new Error("tok");
	}
	function term(): PropValue {
		let v = primary();
		while (peek() && (peek()!.v === "*" || peek()!.v === "/")) {
			const op = next()!.v;
			const r = primary();
			v = op === "*" ? num(v) * num(r) : num(r) === 0 ? null : num(v) / num(r);
		}
		return v;
	}
	function sum(): PropValue {
		let v = term();
		while (peek() && (peek()!.v === "+" || peek()!.v === "-")) {
			const op = next()!.v;
			const r = term();
			if (op === "+") v = typeof v === "string" || typeof r === "string" ? propToText(v) + propToText(r) : num(v) + num(r);
			else v = num(v) - num(r);
		}
		return v;
	}
	function comparison(): PropValue {
		const l = sum();
		const op = peek()?.v;
		if (op === "==" || op === "!=" || op === ">" || op === "<" || op === ">=" || op === "<=") {
			next();
			const r = sum();
			const c = compareProp(l, r);
			return op === "==" ? c === 0 : op === "!=" ? c !== 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : op === ">=" ? c >= 0 : c <= 0;
		}
		return l;
	}
	try {
		const v = comparison();
		return i < toks.length ? "⚠" : v;
	} catch {
		return "⚠";
	}
}

function tokenizeFormula(s: string): { k: "num" | "str" | "id" | "op"; v: string | number }[] | null {
	const out: { k: "num" | "str" | "id" | "op"; v: string | number }[] = [];
	let i = 0;
	while (i < s.length) {
		const ch = s[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const num = /^\d+(\.\d+)?/.exec(s.slice(i));
		if (num) {
			out.push({ k: "num", v: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const end = s.indexOf(ch, i + 1);
			if (end < 0) return null;
			out.push({ k: "str", v: s.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		const id = /^[A-Za-z_][\w.]*/.exec(s.slice(i));
		if (id) {
			out.push({ k: "id", v: id[0] });
			i += id[0].length;
			continue;
		}
		const op = /^(==|!=|>=|<=|[-+*/(),<>])/.exec(s.slice(i));
		if (op) {
			out.push({ k: "op", v: op[0] });
			i += op[0].length;
			continue;
		}
		return null;
	}
	return out;
}

/** Every property key used across the vault (for column pickers). */
export function allPropKeys(notes: readonly NoteMeta[]): string[] {
	const keys = new Set<string>();
	for (const n of notes) for (const k of Object.keys(n.props)) keys.add(k);
	return [...keys].sort((a, b) => a.localeCompare(b));
}

// ─── Daily notes / templates ────────────────────────────────────────────────

export function isoDate(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Template variables (Obsidian core Templates): {{title}} {{date}}
 *  {{time}} {{date:YYYY-MM-DD}}. */
export function fillTemplate(tpl: string, title: string, now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const fmt = (f: string) =>
		f
			.replace(/YYYY/g, String(now.getFullYear()))
			.replace(/MM/g, p(now.getMonth() + 1))
			.replace(/DD/g, p(now.getDate()))
			.replace(/HH/g, p(now.getHours()))
			.replace(/mm/g, p(now.getMinutes()))
			.replace(/dddd/g, now.toLocaleDateString("en-US", { weekday: "long" }));
	return tpl
		.replace(/\{\{\s*title\s*\}\}/g, title)
		.replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_m, f?: string) => (f ? fmt(f.trim()) : isoDate(now)))
		.replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_m, f?: string) => (f ? fmt(f.trim()) : `${p(now.getHours())}:${p(now.getMinutes())}`));
}

// ─── Reading-view preprocessing ─────────────────────────────────────────────

export interface RenderLinkContext {
	resolve: (target: string) => string | null;
	/** Text of a note for transclusion (null = unknown). */
	readNote?: (path: string) => string | null;
	depth?: number;
}

/** Href for opening a note inside the app. */
export function noteHref(path: string, sub?: { heading?: string; block?: string }): string {
	const frag = sub?.heading ? `#${encodeURIComponent(sub.heading)}` : sub?.block ? `#%5E${encodeURIComponent(sub.block)}` : "";
	return `/notes?open=${encodeURIComponent(path)}${frag}`;
}

export function rawHref(path: string): string {
	return `/api/notes/raw?path=${encodeURIComponent(path)}`;
}

const CALLOUT_ICONS: Record<string, string> = {
	note: "✎", abstract: "≡", summary: "≡", tldr: "≡", info: "ℹ", todo: "☐", tip: "✦", hint: "✦", important: "✦",
	success: "✓", check: "✓", done: "✓", question: "?", help: "?", faq: "?", warning: "⚠", caution: "⚠", attention: "⚠",
	failure: "✗", fail: "✗", missing: "✗", danger: "⚡", error: "⚡", bug: "🐞", example: "❖", quote: "❝", cite: "❝",
};

export function calloutIcon(type: string): string {
	return CALLOUT_ICONS[type.toLowerCase()] ?? "✎";
}

/** Turn Obsidian syntax into Markdown the shared renderer understands:
 *  wikilinks → app links, ![[image|300]] → images, ![[note]] → transcluded
 *  quote, ==highlight== → <mark>, %%comments%% removed, #tags → tag links.
 *  Code spans/blocks are left untouched. */
export function preprocessForReading(text: string, ctx: RenderLinkContext): string {
	// %%comments%% vanish in reading view (also across lines).
	const body = parseFrontmatter(text).body.replace(/%%[\s\S]*?%%/g, "");
	const masked = maskCode(body);
	// Code regions are where the mask differs from the raw text; walk runs of
	// code / non-code so code stays verbatim. (A space inside code reads as
	// non-code, which is harmless: a lone space transforms to itself.)
	let out = "";
	let i = 0;
	while (i < body.length) {
		const code = masked[i] !== body[i];
		let j = i;
		while (j < body.length && (masked[j] !== body[j]) === code) j++;
		const seg = body.slice(i, j);
		out += code ? seg : transformInline(seg, ctx);
		i = j;
	}
	return out;
}

function transformInline(seg: string, ctx: RenderLinkContext): string {
	const depth = ctx.depth ?? 0;
	let s = seg;
	// Embeds first.
	s = s.replace(/!\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
		const l = parseWikiInner(inner);
		const path = ctx.resolve(l.target);
		if (!path) return `<span class="lh-unresolved">${escapeHtml(l.target)}</span>`;
		if (isImagePath(path)) {
			const size = l.alias && /^\d+(x\d+)?$/.test(l.alias) ? l.alias : "";
			const alt = size ? `${noteTitle(path)}|${size}` : l.alias ?? noteTitle(path);
			return `![${alt.replace(/[[\]]/g, "")}](${rawHref(path)})`;
		}
		if (!isNotePath(path)) return `[${basename(path)}](${rawHref(path)})`;
		const text = depth < 2 ? ctx.readNote?.(path) : null;
		if (text == null) return `[${l.alias ?? noteTitle(path)}](${noteHref(path, l)})`;
		const section = l.heading || l.block ? extractSection(text, l) : parseFrontmatter(text).body.trim();
		const inner2 = preprocessForReading(section ?? "", { ...ctx, depth: depth + 1 });
		const head = `[${noteTitle(path)}${l.heading ? " › " + l.heading : ""}](${noteHref(path, l)})`;
		return `\n\n> [!embed] ${head}\n${inner2.split("\n").map((ln) => "> " + ln).join("\n")}\n\n`;
	});
	s = s.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
		const l = parseWikiInner(inner);
		const label = l.alias ?? (l.target ? noteTitle(l.target) : "") + (l.heading ? (l.target ? " › " : "") + l.heading : "") + (l.block ? " ^" + l.block : "");
		const path = l.target ? ctx.resolve(l.target) : null;
		if (!l.target && (l.heading || l.block)) return `[${escapeMdLabel(label)}](#${encodeURIComponent(l.heading ?? "^" + l.block)})`;
		if (!path) return `[${escapeMdLabel(label)}](/notes?create=${encodeURIComponent(l.target)})`;
		return `[${escapeMdLabel(label)}](${isNotePath(path) ? noteHref(path, l) : rawHref(path)})`;
	});
	// Tags (not inside links/headings).
	s = s.replace(/(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu, (m, pre: string, tag: string, offset: number, whole: string) => {
		if (pre === "(" && whole[offset - 1] === "]") return m; // a link target, not a tag
		const lineStart = whole.lastIndexOf("\n", offset) + 1;
		if (/^#{1,6}$/.test(whole.slice(lineStart, offset + pre.length).trim() + "")) return m;
		return `${pre}[#${tag}](/notes?tag=${encodeURIComponent(tag)})`;
	});
	// Highlights: ==text== (Obsidian) and =={color}text== (1.14 colors). The
	// renderer sanitizes raw HTML, so they ride a marker link the reading
	// view's <a> override turns into <mark>.
	s = s.replace(/==(?:\{(red|orange|yellow|green|blue|purple|pink)\})?([^=\n](?:[^=\n]|=(?!=))*?)==/g, (_m, color: string | undefined, t: string) => `[${t}](#lh-mark${color ? "-" + color : ""})`);
	// Block ids are invisible in reading view.
	s = s.replace(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/gm, "");
	return s;
}

function escapeMdLabel(s: string): string {
	return s.replace(/([[\]])/g, "\\$1");
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
