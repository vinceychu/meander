/**
 * COURSE PARSING — the pure half of "grab the syllabus" (2026-11-09).
 *
 * Every function here takes HTML (or a subtitle track) and returns a
 * structure. No network, no fs — the fetching and the caching live in
 * src/server/courses.ts. Keeping the parsing pure is what makes the
 * fixtures in tests/fixtures/ worth anything: a saved CS50 page parses the
 * same way tomorrow as it did today.
 *
 * The parsers are written against CS50's own markup (a Jekyll site with
 * clean <main> regions, <h1>/<h2> headings and relative links) but nothing
 * in here is CS50-specific: the shapes are generic (a unit page, a problem
 * list, a problem spec), so another course's pages can be parsed by the
 * same code once its URLs are mapped.
 */

/** Decode the HTML entities a course page actually uses. */
export function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		rsquo: "’",
		lsquo: "‘",
		ldquo: "“",
		rdquo: "”",
		hellip: "…",
		mdash: "—",
		ndash: "–",
		middot: "·",
		times: "×",
		deg: "°",
	};
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		const hit = named[entity.toLowerCase()];
		return hit ?? whole;
	});
}

/** The page's <main> region (the content column), or the whole document. */
export function mainRegion(html: string): string {
	const start = html.search(/<main\b/i);
	if (start < 0) return html;
	const end = html.indexOf("</main>", start);
	return end < 0 ? html.slice(start) : html.slice(start, end);
}

/** Strip scripts, styles and tags; keep the readable text. */
export function htmlToText(html: string): string {
	const cleaned = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");
	const withBreaks = cleaned
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|pre|blockquote|table)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	return decodeEntities(withBreaks)
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0))
		.join("\n")
		.trim();
}

/** A light HTML → markdown conversion (headings, lists, code, links). */
export function htmlToMarkdown(html: string): string {
	let out = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	// Code blocks first — their content must not be touched by the inline rules.
	const codeBlocks: string[] = [];
	out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
		const body = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\n+$/, "");
		codeBlocks.push(body);
		return `\u0000CODE${codeBlocks.length - 1}\u0000`;
	});
	out = out
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_w, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${inline(inner)}\n\n`)
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_w, inner: string) => `\n- ${inline(inner).trim()}`)
		.replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, "\n")
		.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_w, inner: string) => `\n> ${inline(inner).trim()}\n`)
		.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_w, inner: string) => `\n${inline(inner).trim()}\n`)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	out = decodeEntities(out)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	out = out.replace(/\u0000CODE(\d+)\u0000/g, (_w, index: string) => `\n\`\`\`\n${codeBlocks[Number(index)]}\n\`\`\`\n`);
	return out.trim();
}

/** Inline markup → markdown (links, bold, italic, code). */
function inline(html: string): string {
	return decodeEntities(
		html
			.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, inner: string) => {
				const text = inner.replace(/<[^>]+>/g, "").trim();
				return `[${text}](${href})`;
			})
			.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `**${inner.replace(/<[^>]+>/g, "")}**`)
			.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_w, _t, inner: string) => `*${inner.replace(/<[^>]+>/g, "")}*`)
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_w, inner: string) => `\`${inner.replace(/<[^>]+>/g, "")}\``),
	);
}

/** Absolute URL against a base. */
export function absoluteUrl(href: string, baseUrl: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return href;
	}
}

/** The page's <h1> — the unit/problem title. */
export function firstHeading(html: string): string {
	const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	if (!match || match[1] === undefined) return "";
	return decodeEntities(match[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Every heading of the page (the notes' table of contents). */
export function headings(html: string): Array<{ level: number; title: string }> {
	const out: Array<{ level: number; title: string }> = [];
	for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
		const title = decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
		if (title) out.push({ level: Number(match[1]), title });
	}
	return out;
}

/** The links of a region: {href, text}. */
export function links(html: string): Array<{ href: string; text: string }> {
	const out: Array<{ href: string; text: string }> = [];
	for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const text = decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
		out.push({ href: match[1] ?? "", text });
	}
	return out;
}

/** The distribution archives a spec points at.
 *
 *  CS50 specs hand out starter code as `wget https://cdn.cs50.net/....zip`
 *  lines (some editions also link the zip directly). Both forms are read;
 *  nothing else is treated as a distribution archive. */
export function extractDistributionUrls(text: string): string[] {
	const found: string[] = [];
	const push = (url: string) => {
		const clean = url.trim().replace(/[),.;'"]+$/, "");
		if (!/^https?:\/\//i.test(clean)) return;
		if (!/\.zip(\?|$)/i.test(clean)) return;
		if (!found.includes(clean)) found.push(clean);
	};
	// The explicit form: a wget/unzip line.
	for (const match of text.matchAll(/\b(?:wget|curl\s+-O\s+-L)\s+(?:-\S+\s+)*(\S+)/gi)) {
		const url = match[1] ?? "";
		if (url) push(url);
	}
	// The bare form: a cdn.cs50.net zip link anywhere in the text.
	for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]*?\.zip/gi)) push(match[0]);
	return found;
}

/** The check50 slug a spec grades with ("cs50/problems/2026/x/mario/less"). */
export function extractCheckSlug(text: string): string | null {
	const match = /\b(cs50\/problems\/[A-Za-z0-9._\-\/]+)/.exec(text);
	return match?.[1] ? match[1].replace(/[.,;)]+$/, "") : null;
}

/** The file a spec asks the learner to write ("mario.c"). */
export function extractFileName(text: string): string | null {
	const match = /\bfile called\s+([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/i.exec(text);
	return match?.[1] ?? null;
}

/** The folder a spec asks the learner to work in ("mario-less"). */
export function extractFolderName(text: string): string | null {
	const match = /\bfolder called\s+([A-Za-z0-9_.-]+)/i.exec(text);
	return match?.[1] ?? null;
}

/** One unit page (a CS50 "week"). */
export interface UnitPage {
	title: string;
	/** The unit's one-paragraph summary. */
	summary: string;
	notesUrl: string;
	psetUrl: string;
	/** The unit's PROJECTS page (the CS50 family calls the problem sets
	 *  "projects" in the AI and web courses). */
	projectsUrl?: string;
	/** The lecture's YouTube id (the CS50 player embeds it). */
	videoId?: string;
	/** The lecture's English subtitle track (timestamped). */
	subtitlesUrl?: string;
	/** The lecture's plain transcript. */
	transcriptUrl?: string;
}

/** Parse a unit page (weeks/N). */
export function parseUnitPage(html: string, baseUrl: string): UnitPage {
	const main = mainRegion(html);
	const title = firstHeading(main);
	// The summary is the first paragraph of the unit page.
	const summary = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(main)?.[1] ?? "";
	const summaryText = decodeEntities(summary.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
	const all = links(main);
	const notes = all.find((l) => /\/notes\/[^/]+\/?$/.test(l.href));
	const pset = all.find((l) => /\/psets\/[^/]+\/?$/.test(l.href));
	// The AI and web courses call the same thing "projects".
	const projects = all.find((l) => /\/projects\/[^/]+\/?$/.test(l.href));
	// The lecture's video: the page's own player iframe first (the English
	// one), then the first video link, then the youtu.be mirror.
	const iframe = /video\.cs50\.io\/([A-Za-z0-9_-]{6,})/.exec(main);
	const videoLink = all.find((l) => /video\.cs50\.io\/([A-Za-z0-9_-]{6,})/.test(l.href));
	const youTube = all.find((l) => /youtu\.be\/([A-Za-z0-9_-]{6,})/.test(l.href));
	const videoId = iframe?.[1] ?? /video\.cs50\.io\/([A-Za-z0-9_-]{6,})/.exec(videoLink?.href ?? "")?.[1] ?? /youtu\.be\/([A-Za-z0-9_-]{6,})/.exec(youTube?.href ?? "")?.[1];
	// The English subtitle track + transcript (the other languages are
	// ignored — the plan speaks the learner's language, the notes do too).
	const subs = all.find((l) => /\.srt$/i.test(l.href) && /\/lang\/en\//i.test(l.href)) ?? all.find((l) => /\.srt$/i.test(l.href));
	const transcript =
		all.find((l) => /\.txt$/i.test(l.href) && /\/lang\/en\//i.test(l.href)) ??
		all.find((l) => /\.txt$/i.test(l.href) && /lecture|aula|clase/i.test(l.href));
	return {
		title,
		summary: summaryText,
		notesUrl: notes ? absoluteUrl(notes.href, baseUrl) : "",
		psetUrl: pset ? absoluteUrl(pset.href, baseUrl) : "",
		...(projects ? { projectsUrl: absoluteUrl(projects.href, baseUrl) } : {}),
		...(videoId ? { videoId } : {}),
		...(subs ? { subtitlesUrl: absoluteUrl(subs.href, baseUrl) } : {}),
		...(transcript ? { transcriptUrl: absoluteUrl(transcript.href, baseUrl) } : {}),
	};
}

/** One unit page in the course's unit index. */
export interface UnitIndexEntry {
	title: string;
	/** The unit page (absolute). */
	url: string;
}

/** Parse the course's unit index (the page listing every unit). */
export function parseUnitIndex(html: string, baseUrl: string): UnitIndexEntry[] {
	const main = mainRegion(html);
	const out: UnitIndexEntry[] = [];
	const seen = new Set<string>();
	for (const link of links(main)) {
		const href = link.href.trim();
		if (!href || href.startsWith("#") || href.startsWith("/") || href.includes("..")) continue;
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
		if (!/^[A-Za-z0-9._~-]+\/?$/.test(href)) continue;
		const url = absoluteUrl(href, baseUrl);
		if (seen.has(url)) continue;
		seen.add(url);
		out.push({ title: link.text || href.replace(/\/$/, ""), url });
	}
	return out;
}

/** One problem link on a problem-set page. */
export interface ProblemLink {
	/** The problem's title ("Mario"). */
	title: string;
	/** The spec page (absolute). */
	specUrl: string;
	/** "less" / "more" / "standard". */
	variant: "less" | "more" | "standard";
}

/** Parse a problem-set page into the problems it asks for.
 *
 *  Only RELATIVE links inside the content column count: the page's chrome
 *  (nav, footer) links elsewhere, and the "less"/"more" variant shows up
 *  as the last path segment ("mario/less/"). */
export function parseProblemSetPage(html: string, baseUrl: string): ProblemLink[] {
	const main = mainRegion(html);
	const out: ProblemLink[] = [];
	const seen = new Set<string>();
	for (const link of links(main)) {
		const href = link.href.trim();
		if (!href || href.startsWith("#") || href.startsWith("/") || href.includes("..")) continue;
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
		if (/\.[a-z0-9]{1,5}(?:[?#]|$)/i.test(href)) continue;
		const segments = href.replace(/\/+$/, "").split("/");
		const last = segments[segments.length - 1] ?? "";
		if (!last) continue;
		const variant: ProblemLink["variant"] = last === "less" || last === "more" ? last : "standard";
		const name = segments.length > 1 ? (segments[segments.length - 2] ?? last) : last;
		let title = link.text.replace(/^this version of\s+/i, "").trim();
		if (!title || /^this version$/i.test(title)) title = name;
		const specUrl = absoluteUrl(href, baseUrl);
		if (seen.has(specUrl)) continue;
		seen.add(specUrl);
		out.push({ title, specUrl, variant });
	}
	return out;
}

/** One problem spec page. */
export interface SpecPage {
	title: string;
	/** The check50 slug, when the page states one. */
	slug: string | null;
	/** The file the learner writes ("mario.c"). */
	fileName: string | null;
	/** The folder the learner works in ("mario-less"). */
	folderName: string | null;
	/** The starter archives (may be empty). */
	distributionUrls: string[];
	/** The official walkthrough video (a demo worth watching). */
	videoEmbeds: Array<{ youtubeId: string; startSeconds?: number }>;
	/** The spec's task text (markdown). */
	taskMarkdown: string;
	/** The starter code the spec hands out (its first code block). */
	starterCode?: string;
	/** The language the problem is written in. */
	language: SpecLanguage;
}

/** The languages a problem can be in. */
export type SpecLanguage = "c" | "python" | "sql" | "html" | "text";

/** Guess the language from the spec's own words. */
export function detectLanguage(text: string): SpecLanguage {
	const lower = text.toLowerCase();
	if (/\bprogram in c\b|\bcs50\.h\b|\bget_int\b|#include\s*<cs50\.h>/i.test(lower)) return "c";
	if (/\bpython\b|\.py\b|import\s+csv\b|def\s+\w+\s*\(/i.test(lower)) return "python";
	if (/\bsql\b|\bselect\b.*\bfrom\b/i.test(lower)) return "sql";
	if (/\bhtml\b|\bcss\b|<\/?html>/i.test(lower)) return "html";
	return "text";
}

/** Parse a problem spec page. */
export function parseSpecPage(html: string, baseUrl: string): SpecPage {
	const main = mainRegion(html);
	const title = firstHeading(main) || "Problem";
	const text = htmlToText(main);
	const markdown = htmlToMarkdown(main);
	const slug = extractCheckSlug(text);
	// The page's embedded videos (the problem demo, the official walkthrough),
	// each with the start time its embed carries — a REAL timestamp.
	const videoEmbeds: Array<{ youtubeId: string; startSeconds?: number }> = [];
	for (const match of main.matchAll(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})([^"']*)/gi)) {
		const start = /[?&](?:amp;)?start=(\d+)/i.exec(match[2] ?? "");
		videoEmbeds.push({
			youtubeId: match[1]!,
			...(start ? { startSeconds: Number(start[1]) } : {}),
		});
	}
	const codeBlocks = [...main.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) =>
		decodeEntities((m[1] ?? "").replace(/<[^>]+>/g, "")).replace(/\n+$/, ""),
	);
	// The starter code is the first block that looks like source (not ASCII art).
	const starter = codeBlocks.find((b) => /#include|def |import |SELECT|<html|int main|function/i.test(b));
	return {
		title,
		slug,
		fileName: extractFileName(text),
		folderName: extractFolderName(text),
		distributionUrls: extractDistributionUrls(text),
		videoEmbeds,
		taskMarkdown: markdown,
		...(starter ? { starterCode: starter } : {}),
		language: detectLanguage(`${text}\n${starter ?? ""}`),
	};
}

/** One entry of a sampled subtitle timeline. */
export interface TimelineEntry {
	/** Seconds from the start of the video. */
	seconds: number;
	/** The caption text at that point (a couple of lines). */
	text: string;
}

/** Parse an SRT subtitle track into a sampled timeline.
 *
 *  The sampled timeline is what makes video segments honest: every
 *  timestamp the tutor picks comes from the lecture's own captions, so a
 *  segment link can never point at a moment that does not exist. */
export function parseSrtTimeline(srt: string, opts: { stepSeconds?: number; maxEntries?: number } = {}): TimelineEntry[] {
	const step = opts.stepSeconds ?? 30;
	const max = opts.maxEntries ?? 120;
	const captions: Array<{ seconds: number; text: string }> = [];
	for (const block of srt.split(/\r?\n\r?\n/)) {
		const stamp = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/.exec(block);
		if (!stamp) continue;
		const seconds = Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
		const lines = block
			.split(/\r?\n/)
			.filter((line) => !/^\d+$/.test(line.trim()) && !/-->/.test(line))
			.map((line) => line.trim())
			.filter(Boolean);
		const text = lines.join(" ").replace(/\s+/g, " ").trim();
		if (text) captions.push({ seconds, text });
	}
	if (captions.length === 0) return [];
	const out: TimelineEntry[] = [];
	let bucket = -1;
	let parts: string[] = [];
	for (const caption of captions) {
		const key = Math.floor(caption.seconds / step);
		if (key !== bucket) {
			if (bucket >= 0 && parts.length) out.push({ seconds: bucket * step, text: parts.join(" ") });
			bucket = key;
			parts = [];
			if (out.length >= max) return out;
		}
		parts.push(caption.text);
	}
	if (bucket >= 0 && parts.length && out.length < max) out.push({ seconds: bucket * step, text: parts.join(" ") });
	return out;
}

/** "1:23:45" → seconds. */
export function parseTimestamp(value: string): number | null {
	const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
	return hours * 3600 + minutes * 60 + seconds;
}

/** "1:23:45" ← seconds. */
export function formatTimestamp(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * The CONDENSED LESSON — the fallback a unit gets when the tutor has not
 * written one yet: the notes' own structure (headings) with the opening of
 * each section. It is a digest of the notes, never a substitute for them —
 * the tutor's own lesson replaces it as soon as it is written.
 *
 * Pure and dependency-free: it works on the markdown the notes page was
 * converted to, so it runs on a cached page with no network.
 */
export function condenseNotes(markdown: string, opts: { maxChars?: number } = {}): string {
	const max = opts.maxChars ?? 6000;
	const lines = markdown.split(/\r?\n/);
	const out: string[] = [];
	let budget = max;
	for (const line of lines) {
		const heading = /^(#{1,4})\s+(.*)$/.exec(line.trim());
		if (heading) {
			const title = heading[2]!.trim();
			if (!title || title === "Table of Contents") continue;
			const entry = `\n${heading[1]} ${title}\n`;
			if (entry.length > budget) break;
			out.push(entry);
			budget -= entry.length;
			continue;
		}
		const text = line.trim();
		// Keep the first sentence of each paragraph; drop lists, code and tables.
		if (!text || text.startsWith("|") || text.startsWith("-") || text.startsWith("```")) continue;
		const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200);
		const entry = `${sentence}\n`;
		if (entry.length > budget) break;
		out.push(entry);
		budget -= entry.length;
	}
	return out.join("").trim();
}
