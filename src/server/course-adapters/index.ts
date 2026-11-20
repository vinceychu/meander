/**
 * THE ADAPTER REGISTRY — which adapter handles which course (2026-11-09).
 *
 * Two adapters ship:
 *
 *   cs50     the CS50 family (CS50x, CS50P, CS50AI, CS50W, CS50SQL,
 *            CS50R, CS50 Cybersecurity) — one site structure, one grader.
 *   generic  everything else: any course URL, read by crawling the page
 *            and letting the model extract the outline.
 *
 * The registry is the only place that knows which is which: the course
 * service, the agent tool and the UI all ask it, so a new course family
 * is one adapter plus one line here.
 *
 * It also RESOLVES a reference — a catalogue id, a course URL or a course
 * name — into the course it names, which is what makes "I want to learn
 * <anything>" work with one prompt.
 */

import { type CourseRequest, type ResolvedCourse } from "../../core/courses.ts";
import type { CourseAdapter } from "../../core/course-adapters.ts";
import { asWebUrl, isWebUrl, looksLikeCoursePage } from "../../core/course-outline.ts";
import type { SearchProvider } from "../../core/search.ts";
import { searchProvider } from "../search.ts";
import { cs50Adapter, cs50Course, cs50CourseFor, looseCs50Course, CS50_CATALOG } from "./cs50.ts";
import { courseIdForUrl, genericAdapter } from "./generic.ts";

/** Every adapter, in the order they are asked. */
export const ADAPTERS: CourseAdapter[] = [cs50Adapter, genericAdapter];

/** The adapter that handles a reference (the generic one is the fallback). */
export function adapterFor(ref: string): CourseAdapter {
	const trimmed = ref.trim();
	for (const adapter of ADAPTERS) {
		if (adapter.detect(trimmed)) return adapter;
	}
	return genericAdapter;
}

/** Is this reference a web page? (A scheme-less host counts.) */
function isUrl(ref: string): boolean {
	return isWebUrl(ref);
}

/** The seams the search fallback runs on (the tests replace them). */
export interface CourseSearchOptions {
	/** The search engine (the app's configured one by default). */
	provider?: SearchProvider | null;
	/** The page fetcher (the app's plain fetch by default). */
	fetch?: (url: string) => Promise<string>;
}

/** How long one search hit's page may take (the hits are read together). */
const CANDIDATE_TIMEOUT_MS = 8_000;

/** The plain page fetch the search fallback reads with. */
async function fetchPageText(url: string): Promise<string> {
	const response = await fetch(url, { headers: { "User-Agent": "Meander (course lookup)" }, signal: AbortSignal.timeout(CANDIDATE_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`the page answered ${response.status}`);
	return response.text();
}

/**
 * Find a course's official page for a NAME.
 *
 * The catalogue is asked first (the caller does that); this is the second
 * step — a web search for the course, and the first result whose page
 * REALLY looks like a course: a syllabus, a schedule, lectures, labs…
 * (a search for a course name also returns a forum thread or a Wikipedia
 * entry, and those are not the course).
 *
 * A search engine that is not configured is reported honestly: the answer
 * is "paste the URL", never a guess.
 */
export async function findCoursePage(name: string, opts: CourseSearchOptions = {}): Promise<string | null> {
	const provider = opts.provider === undefined ? searchProvider() : opts.provider;
	if (!provider) return null;
	let hits: Awaited<ReturnType<typeof provider.search>>;
	try {
		hits = await provider.search(`${name} course official site`, 8);
	} catch {
		return null;
	}
	const read = opts.fetch ?? fetchPageText;
	const pages: string[] = [];
	for (const hit of hits) {
		const url = hit.url?.trim();
		if (!url || !isUrl(url)) continue;
		const page = asWebUrl(url);
		try {
			const parsed = new URL(page);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
		} catch {
			continue;
		}
		pages.push(page);
	}
	// The hits are read together (one slow page does not hold up the
	// rest), and the FIRST hit in the search's order that looks like a
	// course's own page wins — the others are not the course.
	const verdicts = await Promise.all(
		pages.map(async (page) => {
			try {
				return looksLikeCoursePage(await read(page), page);
			} catch {
				return false; // a page that will not fetch is not the course's page
			}
		}),
	);
	const index = verdicts.indexOf(true);
	if (index >= 0) return pages[index]!;
	return null;
}

/**
 * RESOLVE A REFERENCE — a catalogue id, a course URL or a course name —
 * into the course it names.
 *
 * The order is the one the learner would expect:
 *   1. the catalogue (the CS50 family, by id or by title);
 *   2. a URL (the course's own page — with or without its scheme);
 *   3. a name (the catalogue again by a loose match, then a web search).
 *
 * The resolved course's `ref` is always something the adapter registry can
 * route: the catalogue's id, or the course's own URL. A name that resolves
 * to a course page is remembered BY THAT PAGE, so the adapter that reads
 * the course is the adapter that built it.
 */
export async function resolveCourseRef(ref: string, opts: CourseSearchOptions = {}): Promise<ResolvedCourse> {
	const needle = ref.trim();
	if (!needle) throw new Error("No course was named.");

	// 1. the CS50 family, by id, by title or by its own URL.
	const cs50 = cs50CourseFor(needle);
	if (cs50) {
		return {
			courseId: cs50.id,
			ref: cs50.id,
			title: cs50.title,
			source: cs50.source,
			...(cs50.edition ? { edition: cs50.edition } : {}),
			adapter: "cs50",
		};
	}

	// 2. a URL — the course's own page ("cs61a.org" counts as one).
	if (isUrl(needle)) {
		const url = asWebUrl(needle);
		const id = courseIdForUrl(url);
		return {
			courseId: id,
			ref: url,
			title: id,
			source: url,
			adapter: adapterFor(url).id,
		};
	}

	// 3. a name. The catalogue by a loose match — but only a REAL one:
	// the name has to name the family ("cs50 python"), not just a word
	// that happens to be in a title ("python" is a language, not a course).
	const loose = looseCs50Course(needle);
	if (loose) {
		return {
			courseId: loose.id,
			ref: loose.id,
			title: loose.title,
			source: loose.source,
			...(loose.edition ? { edition: loose.edition } : {}),
			adapter: "cs50",
		};
	}

	// …and the web, for everything else.
	const page = await findCoursePage(needle, opts);
	if (!page) {
		throw new Error(
			`No course named "${needle}" is in the catalogue, and no search engine is available to find it. ` +
				"Paste the course's URL instead — any course page works.",
		);
	}
	return {
		courseId: courseIdForUrl(page),
		ref: page,
		title: needle,
		source: page,
		adapter: adapterFor(page).id,
	};
}

/** The request an adapter needs, from a resolved course. */
export function requestFor(resolved: ResolvedCourse): CourseRequest {
	const cs50 = cs50Course(resolved.courseId);
	return {
		courseId: resolved.courseId,
		ref: resolved.ref,
		source: resolved.source,
		...(cs50?.indexUrl ? { indexUrl: cs50.indexUrl } : {}),
		title: resolved.title,
		...(resolved.edition ? { edition: resolved.edition } : {}),
	};
}

export { cs50Adapter, cs50Course, cs50CourseFor, CS50_CATALOG, genericAdapter };
