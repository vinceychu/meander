/**
 * THE GENERIC OUTLINE — what the model extracts from a crawled course
 * (2026-11-09).
 *
 * The generic adapter cannot know what a course's syllabus looks like, so
 * it reads the pages and asks the model for the SAME shape the CS50
 * adapter produces: units, their notes, their videos, their problems.
 *
 * Two laws, and they are the point of this module:
 *
 *   1. EVERY URL in the answer must be one the crawl SAW. A model that
 *      invents a plausible-looking URL ("https://cs61a.org/2025/sp/lab01/")
 *      is rejected — the answer is rebuilt from the pages, never from the
 *      model's imagination.
 *   2. A video TIMESTAMP is only kept when the page itself carries it
 *      (the URL's own `t=`/`start=` mark). Otherwise the video is stored
 *      as a plain link — never with an invented second.
 *
 * Pure: the model is a seam (`OutlineModel`), so the whole extraction is
 * testable with a fake model and fixture pages.
 */

import { Type } from "typebox";
import { absoluteUrl, htmlToText } from "./course-parse.ts";
import type { CrawledPage } from "./course-crawl.ts";

/** One video the model found (a lecture, a recording). */
export interface OutlineVideoDraft {
	title: string;
	/** The video's page (a YouTube watch URL, a recording page). */
	url?: string;
	/** The YouTube id, when the URL carries one. */
	youtubeId?: string;
	/** The start time, when the page states one. */
	startSeconds?: number;
}

/** One problem the model found. */
export interface OutlineProblemDraft {
	/** A stable id (the model may propose one; the adapter makes it safe). */
	id?: string;
	title: string;
	/** The page that states the problem (the spec). */
	specUrl?: string;
	/** The starter archive the course hands out (a zip or a tarball). */
	starterUrl?: string;
	/** The starter repository (a GitHub repo). */
	repoUrl?: string;
	/** The language the problem is written in. */
	language?: string;
	/** The grader the course uses ("check50", "autograder", "tests", …). */
	grader?: string;
}

/** One unit the model found (a week, a module, a chapter). */
export interface OutlineUnitDraft {
	title: string;
	/** The unit's one-paragraph summary. */
	summary?: string;
	/** The notes / readings pages of the unit. */
	notesUrls?: string[];
	/** The unit's own page in the course. */
	pageUrl?: string;
	/** The unit's videos. */
	videos?: OutlineVideoDraft[];
	/** The unit's problems. */
	problems?: OutlineProblemDraft[];
}

/** The whole outline the model returns. */
export interface OutlineDraft {
	title: string;
	units: OutlineUnitDraft[];
}

// ─── the schema the model must satisfy ──────────────────────────────────────

export const outlineVideoSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	url: Type.Optional(Type.String()),
	youtubeId: Type.Optional(Type.String()),
	startSeconds: Type.Optional(Type.Number()),
});

export const outlineProblemSchema = Type.Object({
	id: Type.Optional(Type.String()),
	title: Type.String({ minLength: 1 }),
	specUrl: Type.Optional(Type.String()),
	starterUrl: Type.Optional(Type.String()),
	repoUrl: Type.Optional(Type.String()),
	language: Type.Optional(Type.String()),
	grader: Type.Optional(Type.String()),
});

export const outlineUnitSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	summary: Type.Optional(Type.String()),
	notesUrls: Type.Optional(Type.Array(Type.String())),
	pageUrl: Type.Optional(Type.String()),
	videos: Type.Optional(Type.Array(outlineVideoSchema)),
	problems: Type.Optional(Type.Array(outlineProblemSchema)),
});

/** The outline's schema — the model submits against it, so a malformed
 *  answer never reaches the validator as a course plan. */
export const outlineSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	units: Type.Array(outlineUnitSchema),
});

// ─── reading the model's answer ─────────────────────────────────────────────

/** The JSON in a model's answer (fences and prose around it are ignored). */
export function parseOutlineJson(text: string): OutlineDraft | null {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	const candidates = [fenced?.[1], trimmed];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) continue;
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1)) as OutlineDraft;
			if (parsed && typeof parsed === "object" && Array.isArray(parsed.units)) return parsed;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

// ─── the URL law ────────────────────────────────────────────────────────────

/** A URL, normalized for comparison (no trailing slash, lower host). */
export function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.host.toLowerCase();
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.protocol}//${host}${path}${parsed.search}${parsed.hash}`;
	} catch {
		return url.trim().replace(/\/+$/, "");
	}
}

/**
 * Is this reference a web page?
 *
 * A course's URL is often typed without its scheme ("cs61a.org"), and that
 * is a URL — a learner pasting one means the course's site, not a course
 * called "cs61a.org". A bare host (letters, digits, dots and dashes) with
 * at least one dot is a URL; a name ("python", "CS50x") never is.
 */
export function isWebUrl(ref: string): boolean {
	const trimmed = ref.trim();
	if (!trimmed) return false;
	if (/^https?:\/\//i.test(trimmed)) return true;
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(trimmed);
}

/** A web page's URL, with its scheme (a bare host becomes https). */
export function asWebUrl(ref: string): string {
	const trimmed = ref.trim();
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The words that mark a page as a course's own page.
 *
 * A web search for a course's name also returns a forum thread about it,
 * a Wikipedia entry, a blog post. Only the course's own site is the
 * course — so the page that the search picks has to be CHECKED, not
 * assumed.
 */
const COURSE_WORDS = [
	"course",
	"courses",
	"coursework",
	"syllabus",
	"curriculum",
	"schedule",
	"week",
	"weeks",
	"module",
	"modules",
	"lecture",
	"lectures",
	"assignment",
	"assignments",
	"homework",
	"homeworks",
	"lab",
	"labs",
	"pset",
	"psets",
	"project",
	"projects",
	"readings",
	"student",
	"students",
	"instructor",
	"instructors",
	"professor",
	"credits",
	"exams",
];

/** The words that are enough on their own. */
const STRONG_COURSE_WORDS = new Set([
	"course",
	"courses",
	"coursework",
	"syllabus",
	"curriculum",
	"assignments",
	"homework",
]);

/**
 * Does this page look like a course's own page?
 *
 * The page is READ, not guessed at: a course's page says "course",
 * "syllabus", "assignments" (and links to them). A page that says none of
 * that is not the course — the search moves on to the next hit.
 */
export function looksLikeCoursePage(html: string): boolean {
	const words = new Set(
		htmlToText(html)
			.slice(0, 20_000)
			.toLowerCase()
			.match(/[a-z]+/g) ?? [],
	);
	let hits = 0;
	let strong = false;
	for (const word of COURSE_WORDS) {
		if (!words.has(word)) continue;
		hits++;
		if (STRONG_COURSE_WORDS.has(word)) strong = true;
	}
	return hits >= 2 || (hits >= 1 && strong);
}

/** The allowed-URL set, normalized. */
export function allowedUrlSet(urls: readonly string[]): Set<string> {
	return new Set(urls.map((url) => normalizeUrl(url)));
}

/** Every URL the draft mentions (the ones the law applies to). */
export function draftUrls(draft: OutlineDraft): Array<{ where: string; url: string }> {
	const out: Array<{ where: string; url: string }> = [];
	for (const unit of draft.units) {
		if (unit.pageUrl) out.push({ where: `unit "${unit.title}" pageUrl`, url: unit.pageUrl });
		for (const url of unit.notesUrls ?? []) out.push({ where: `unit "${unit.title}" notes`, url });
		for (const video of unit.videos ?? []) {
			if (video.url) out.push({ where: `unit "${unit.title}" video "${video.title}"`, url: video.url });
		}
		for (const problem of unit.problems ?? []) {
			if (problem.specUrl) out.push({ where: `problem "${problem.title}" specUrl`, url: problem.specUrl });
			if (problem.starterUrl) out.push({ where: `problem "${problem.title}" starterUrl`, url: problem.starterUrl });
			if (problem.repoUrl) out.push({ where: `problem "${problem.title}" repoUrl`, url: problem.repoUrl });
		}
	}
	return out;
}

/**
 * The URL law: every URL the draft mentions must be one the crawl saw.
 * The rejected ones are named — the model gets the chance to fix them.
 */
export function findInventedUrls(draft: OutlineDraft, allowed: Set<string>): string[] {
	const problems: string[] = [];
	for (const { where, url } of draftUrls(draft)) {
		if (allowed.has(normalizeUrl(url))) continue;
		problems.push(`${where}: "${url}" was not on any page the crawl read — invented URLs are rejected.`);
	}
	return problems;
}

/**
 * The URL law, applied as a DROP: the URLs the crawl never saw are taken
 * out of the draft, and the rest of the outline is kept.
 *
 * An invented URL is the model's mistake, not a reason to throw the whole
 * course away: a course with one bad link in one assignment page must
 * still be teachable. The invented URL never reaches the course plan —
 * the field it was in is simply left out.
 *
 * A problem whose SPEC page was invented goes with it: there is no
 * assignment to read. Returns the cleaned draft and the URLs that were
 * dropped (named, so the app can say what it left out).
 */
export function stripInventedUrls(draft: OutlineDraft, allowed: Set<string>): { draft: OutlineDraft; dropped: string[] } {
	const dropped: string[] = [];
	const seen = (url: string): string | undefined => {
		if (allowed.has(normalizeUrl(url))) return url;
		dropped.push(url);
		return undefined;
	};
	const units: OutlineUnitDraft[] = [];
	for (const unit of draft.units) {
		const pageUrl = unit.pageUrl ? seen(unit.pageUrl) : undefined;
		const notesUrls = unit.notesUrls?.map((url) => seen(url)).filter((url): url is string => url !== undefined);
		const videos = unit.videos?.map((video) => {
			if (!video.url) {
				return {
					title: video.title,
					...(video.youtubeId !== undefined ? { youtubeId: video.youtubeId } : {}),
					...(video.startSeconds !== undefined ? { startSeconds: video.startSeconds } : {}),
				};
			}
			const url = seen(video.url);
			// An invented video URL is dropped; the video itself stays (the
			// id it carries is not a URL, so the law does not judge it).
			return {
				title: video.title,
				...(url !== undefined ? { url } : {}),
				...(video.youtubeId !== undefined ? { youtubeId: video.youtubeId } : {}),
				...(video.startSeconds !== undefined ? { startSeconds: video.startSeconds } : {}),
			};
		});
		const problems: OutlineProblemDraft[] = [];
		for (const problem of unit.problems ?? []) {
			const specUrl = problem.specUrl ? seen(problem.specUrl) : undefined;
			// A problem whose spec page was invented is dropped with it.
			if (problem.specUrl && !specUrl) continue;
			const starterUrl = problem.starterUrl ? seen(problem.starterUrl) : undefined;
			const repoUrl = problem.repoUrl ? seen(problem.repoUrl) : undefined;
			problems.push({
				...(problem.id !== undefined ? { id: problem.id } : {}),
				title: problem.title,
				...(specUrl !== undefined ? { specUrl } : {}),
				...(starterUrl !== undefined ? { starterUrl } : {}),
				...(repoUrl !== undefined ? { repoUrl } : {}),
				...(problem.language !== undefined ? { language: problem.language } : {}),
				...(problem.grader !== undefined ? { grader: problem.grader } : {}),
			});
		}
		units.push({
			...unit,
			...(pageUrl !== undefined ? { pageUrl } : {}),
			...(notesUrls !== undefined ? { notesUrls } : {}),
			...(videos !== undefined ? { videos } : {}),
			...(unit.problems !== undefined ? { problems } : {}),
		});
	}
	return { draft: { title: draft.title, units }, dropped };
}

// ─── the timestamp law ──────────────────────────────────────────────────────

/** The start time a video URL itself carries ("?t=90", "?start=90"). */
export function timestampInUrl(url: string): number | undefined {
	const match = /[?&#](?:t|start|start_seconds)=(\d+)/i.exec(url);
	if (!match) return undefined;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) ? seconds : undefined;
}

/** The YouTube id a URL carries (watch, youtu.be, embed, shorts). */
export function youtubeIdInUrl(url: string): string | undefined {
	const patterns = [
		/youtu\.be\/([A-Za-z0-9_-]{6,})/i,
		/youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{6,})/i,
		/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i,
		/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(url);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

/**
 * The timestamp law: a video keeps a start time only when its own URL
 * states one. The model's own number is dropped when the URL does not
 * carry it — the link stays, the invented second does not.
 */
export function videoStartSeconds(video: OutlineVideoDraft): number | undefined {
	const fromUrl = video.url ? timestampInUrl(video.url) : undefined;
	if (fromUrl !== undefined) return fromUrl;
	return undefined;
}

// ─── building the units ─────────────────────────────────────────────────────

/** A slug of a title ("Week 1 C" → "week-1-c"). */
export function slugify(text: string, fallback = "unit"): string {
	const slug = text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

/** The languages a problem can be in (the Run pane's list). */
export type CourseLanguage =
	| "c"
	| "cpp"
	| "python"
	| "sql"
	| "javascript"
	| "typescript"
	| "go"
	| "rust"
	| "html"
	| "text";

/** Normalize a language the model stated ("Python 3" → "python"). */
export function normalizeLanguage(language: string | undefined): CourseLanguage {
	const lower = (language ?? "").toLowerCase();
	if (/\bc\+\+|cpp|g\+\+/.test(lower)) return "cpp";
	if (/\bjavascript\b|\bjs\b|\bnode\b|\breact\b/.test(lower)) return "javascript";
	if (/\btypescript\b|\bts\b/.test(lower)) return "typescript";
	if (/\bpython\b|\bpy\b/.test(lower)) return "python";
	if (/\bsql\b|\bpostgres/.test(lower)) return "sql";
	if (/\bc\b|\bgcc\b/.test(lower)) return "c";
	if (/\bgo\b|golang/.test(lower)) return "go";
	if (/\brust\b/.test(lower)) return "rust";
	if (/\bhtml\b|\bcss\b/.test(lower)) return "html";
	return "text";
}

/** The grader the model stated, normalized to a known kind. */
export function normalizeGrader(grader: string | undefined): "check50" | "autograder" | "tests" | "ai-rubric" | "none" | undefined {
	const lower = (grader ?? "").toLowerCase();
	if (!lower) return undefined;
	if (lower.includes("check50")) return "check50";
	if (lower.includes("autograder") || /\bok\b.*--local/.test(lower)) return "autograder";
	if (lower.includes("test") || lower.includes("pytest") || lower.includes("jest") || lower.includes("vitest")) return "tests";
	if (lower.includes("rubric") || lower.includes("ai") || lower.includes("llm") || lower.includes("review")) return "ai-rubric";
	if (lower.includes("none") || lower.includes("manual")) return "none";
	return undefined;
}

/** Resolve a relative URL against the page it was found on. */
export function resolveAgainst(url: string, base: string): string {
	return absoluteUrl(url, base);
}

// ─── the prompt + the extraction ────────────────────────────────────────────

/** The system prompt the outline extractor runs under. */
export const OUTLINE_SYSTEM_PROMPT = `You extract a course outline from a course's own web pages.

You are given the pages of one course (the course's home page, its syllabus or schedule, its
week pages, its assignment pages). Read them and describe the course's structure.

Answer with ONE JSON object and nothing else:
{
  "title": "the course's own title",
  "units": [
    {
      "title": "the unit's title (a week, a module, a chapter)",
      "summary": "one paragraph: what this unit covers",
      "pageUrl": "the unit's page, exactly as it appears in the pages you were given",
      "notesUrls": ["the unit's notes / readings pages, exactly as they appear"],
      "videos": [{ "title": "the lecture's title", "url": "the video's page, exactly as it appears" }],
      "problems": [
        {
          "title": "the assignment's title",
          "specUrl": "the page that states the assignment, exactly as it appears",
          "starterUrl": "the zip or tarball of the starter code, if the page names one",
          "repoUrl": "the starter repository, if the page links one",
          "language": "the language the assignment is written in",
          "grader": "check50 | autograder | tests | ai-rubric | none"
        }
      ]
    }
  ]
}

THE LAWS:
- Use ONLY URLs that appear in the pages you were given. Never write a URL you did not see.
- Never invent a video timestamp. If a URL carries a time (a "?t=90"), keep the URL as it is.
- If a page does not say, leave the field out. An empty field is honest; a guess is not.
- The units are the course's own: a week, a module, a chapter — whatever the course calls them.
- The problems are the assignments the course asks for. If a unit has none, leave "problems" out.`;

/** The prompt: the pages the crawl read, one after another. */
export function buildOutlinePrompt(pages: CrawledPage[]): string {
	const body = pages
		.map((page) => `# PAGE ${page.url}\nTITLE: ${page.title}\n\n${page.text}`)
		.join("\n\n");
	return `These are the pages of one course. Extract its outline as JSON.\n\n${body}`;
}

/**
 * Resolve every relative URL in a draft against the page it was found on
 * (the model is told to write absolute URLs, but a relative one is still
 * a real link — it just has to be resolved before the URL law sees it).
 */
export function resolveDraftUrls(draft: OutlineDraft, base: string): OutlineDraft {
	const resolve = (url: string | undefined): string | undefined =>
		url === undefined ? undefined : resolveAgainst(url, base);
	return {
		title: draft.title,
		units: draft.units.map((unit) => ({
			title: unit.title,
			...(unit.summary !== undefined ? { summary: unit.summary } : {}),
			...(unit.notesUrls ? { notesUrls: unit.notesUrls.map((url) => resolve(url)!) } : {}),
			...(unit.pageUrl !== undefined ? { pageUrl: resolve(unit.pageUrl) } : {}),
			...(unit.videos
				? {
						videos: unit.videos.map((video) => ({
							title: video.title,
							...(video.url !== undefined ? { url: resolve(video.url) } : {}),
							...(video.youtubeId !== undefined ? { youtubeId: video.youtubeId } : {}),
							...(video.startSeconds !== undefined ? { startSeconds: video.startSeconds } : {}),
						})),
					}
				: {}),
			...(unit.problems
				? {
						problems: unit.problems.map((problem) => ({
							title: problem.title,
							...(problem.id !== undefined ? { id: problem.id } : {}),
							...(problem.specUrl !== undefined ? { specUrl: resolve(problem.specUrl) } : {}),
							...(problem.starterUrl !== undefined ? { starterUrl: resolve(problem.starterUrl) } : {}),
							...(problem.repoUrl !== undefined ? { repoUrl: resolve(problem.repoUrl) } : {}),
							...(problem.language !== undefined ? { language: problem.language } : {}),
							...(problem.grader !== undefined ? { grader: problem.grader } : {}),
						})),
					}
				: {}),
		})),
	};
}

/** The model seam: it answers with the outline's JSON. */
export type OutlineModel = (prompt: string) => Promise<string>;

/** What an extraction produced. */
export type OutlineExtraction =
	| { ok: true; draft: OutlineDraft; dropped: string[] }
	| { ok: false; problems: string[] };

/**
 * Extract the outline from the crawled pages.
 *
 * The URL law is applied here: every URL the model wrote must be one the
 * crawl saw. A URL that was invented is DROPPED (the field it was in is
 * left out, and a problem whose spec page was invented goes with it) —
 * the rest of the course is kept, because one bad link must not cost the
 * learner the whole course. The dropped URLs are named in the result, so
 * the app can say what it left out.
 *
 * An answer with no units at all is not a course: that IS a failure, and
 * it is reported as one.
 */
export async function extractOutline(
	pages: CrawledPage[],
	allowedUrls: readonly string[],
	model: OutlineModel,
): Promise<OutlineExtraction> {
	const prompt = buildOutlinePrompt(pages);
	let text: string;
	try {
		text = await model(prompt);
	} catch (error) {
		return { ok: false, problems: [`the model could not read the course: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const draft = parseOutlineJson(text);
	if (!draft) return { ok: false, problems: ["the model did not answer with a course outline"] };
	const base = pages[0]?.url ?? "";
	const resolved = resolveDraftUrls(draft, base);
	const { draft: clean, dropped } = stripInventedUrls(resolved, allowedUrlSet(allowedUrls));
	if (clean.units.length === 0) {
		return {
			ok: false,
			problems: [
				"the course's outline named no units",
				...dropped.map((url) => `"${url}" was not on any page the crawl read — invented URLs are rejected.`),
			],
		};
	}
	return { ok: true, draft: clean, dropped };
}
