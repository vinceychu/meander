/**
 * THE COURSE CRAWL — how a course nobody has heard of is read (2026-11-09).
 *
 * The generic adapter does not know what a syllabus looks like: it reads
 * the course's own page, follows the links that plausibly lead to the
 * syllabus or the schedule (same host, depth ≤ 2, ≤ 60 pages) and hands
 * the pages to the model, which extracts the outline.
 *
 * The crawl is deliberately small and honest:
 *   - SAME HOST only (a course's own site — never a link out to a forum);
 *   - DEPTH ≤ 2 from the page the learner gave;
 *   - ≤ 60 pages, so a huge site cannot eat the whole budget;
 *   - every page read is cached by the caller (the fetch seam), so the
 *     second run costs no network.
 *
 * Pure: the fetch is a seam, so the crawl is testable against fixture
 * pages with no network at all.
 */

import { absoluteUrl, firstHeading, htmlToMarkdown, htmlToText, links, mainRegion } from "./course-parse.ts";

/** One page the crawl read. */
export interface CrawledPage {
	/** The page's URL (absolute). */
	url: string;
	/** The page's title (its <h1>, else its <title>). */
	title: string;
	/** The page's readable text. */
	text: string;
	/** The page's content column as markdown (the notes a unit is built from). */
	markdown: string;
	/** The links of the content column ({href, text}). */
	links: Array<{ href: string; text: string }>;
}

/** The crawl's result. */
export interface CrawlResult {
	/** The pages that were read (the seed first). */
	pages: CrawledPage[];
	/** Every URL the crawl SAW — a link target or a URL written in a page's
	 *  text. The outline's URLs must come from this set: an invented URL
	 *  is not in it, and is rejected. */
	allowedUrls: string[];
	/** What went wrong (a page that would not fetch is skipped, not fatal). */
	problems: string[];
}

/** The crawl's knobs (the defaults are the app's budget). */
export interface CrawlOptions {
	/** The most pages to read. */
	maxPages?: number;
	/** The most links to follow from the seed (0 = the seed only). */
	maxDepth?: number;
	/** The most links to follow from ONE page. */
	perPage?: number;
	/** Follow links to other hosts too (off by default). */
	crossHost?: boolean;
}

/** The words that mark a link as "the syllabus / the schedule". */
const SYLLABUS_WORDS =
	/syllab|schedul|curricul|outline|weeks?|lectures?|modules?|class notes|readings?|assignments?|labs?|homeworks?|problem sets?|projects?|course home/i;

/** The URL of a page, or null when it is not a web page. */
function webUrl(href: string, base: string): string | null {
	const url = absoluteUrl(href, base);
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

/** The host of a URL ("" when it is not one). */
function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

/** Every URL written in a text (the model often quotes one). */
function urlsInText(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s"'<>()\[\]]+/gi)) {
		const url = match[0].replace(/[.,;:)\]]+$/, "");
		if (url) found.push(url);
	}
	return found;
}

/**
 * Crawl a course's own site.
 *
 * `fetchPage` is the seam: the server passes the caching fetch, a test
 * passes the fixtures. A page that fails to fetch is skipped and reported
 * — the crawl never invents a page.
 */
export async function crawlCourse(
	seedUrl: string,
	fetchPage: (url: string) => Promise<string>,
	opts: CrawlOptions = {},
): Promise<CrawlResult> {
	const maxPages = opts.maxPages ?? 60;
	const maxDepth = opts.maxDepth ?? 2;
	const perPage = opts.perPage ?? 25;
	const seed = webUrl(seedUrl, seedUrl);
	if (!seed) return { pages: [], allowedUrls: [], problems: [`not a web page: ${seedUrl}`] };
	const seedHost = hostOf(seed);

	const pages: CrawledPage[] = [];
	const allowed = new Set<string>();
	const problems: string[] = [];
	const seen = new Set<string>();
	// The frontier: {url, depth}.
	let frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];

	while (frontier.length > 0 && pages.length < maxPages) {
		const next: Array<{ url: string; depth: number }> = [];
		for (const item of frontier) {
			if (pages.length >= maxPages) break;
			if (seen.has(item.url)) continue;
			seen.add(item.url);
			let html: string;
			try {
				html = await fetchPage(item.url);
			} catch (error) {
				problems.push(`${item.url}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const main = mainRegion(html);
			const title = firstHeading(main) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || item.url;
			const text = htmlToText(main);
			const pageLinks = links(main);
			allowed.add(item.url);
			for (const url of urlsInText(text)) allowed.add(url);
			for (const link of pageLinks) {
				const url = webUrl(link.href, item.url);
				if (url) allowed.add(url);
			}
			pages.push({ url: item.url, title, text, markdown: htmlToMarkdown(main), links: pageLinks });
			if (item.depth >= maxDepth) continue;
			// The candidates: same host (unless crossHost), unseen, and not
			// the page itself. The syllabus-ish links go first — they are
			// the ones that carry the course's shape.
			const candidates: Array<{ url: string; text: string; score: number }> = [];
			for (const link of pageLinks) {
				const url = webUrl(link.href, item.url);
				if (!url || url === item.url || seen.has(url)) continue;
				if (!opts.crossHost && hostOf(url) !== seedHost) continue;
				const label = `${link.text} ${url}`;
				candidates.push({ url, text: link.text, score: SYLLABUS_WORDS.test(label) ? 0 : 1 });
			}
			candidates.sort((a, b) => a.score - b.score);
			for (const candidate of candidates.slice(0, perPage)) {
				next.push({ url: candidate.url, depth: item.depth + 1 });
			}
		}
		frontier = next;
	}
	return { pages, allowedUrls: [...allowed], problems };
}

/**
 * The pages the model reads, in the order that helps it most: the seed
 * first, then the syllabus-ish pages, then the rest — each one trimmed to
 * its share of the budget.
 */
export function pagesForModel(pages: CrawledPage[], opts: { maxPages?: number; maxChars?: number; perPageChars?: number } = {}): CrawledPage[] {
	const maxPages = opts.maxPages ?? 24;
	const maxChars = opts.maxChars ?? 60_000;
	const perPageChars = opts.perPageChars ?? 4000;
	const scored = pages.map((page, index) => ({
		page,
		index,
		score: SYLLABUS_WORDS.test(`${page.title} ${page.url}`) ? 0 : index === 0 ? 0 : 1,
	}));
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	const out: CrawledPage[] = [];
	let budget = maxChars;
	for (const { page } of scored) {
		if (out.length >= maxPages || budget <= 0) break;
		const text = page.text.slice(0, Math.min(perPageChars, budget));
		budget -= text.length;
		out.push({ ...page, text });
	}
	return out;
}
