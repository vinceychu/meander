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

import { courseIdFor, type CourseRequest, type ResolvedCourse } from "../../core/courses.ts";
import type { CourseAdapter } from "../../core/course-adapters.ts";
import { searchProvider } from "../search.ts";
import { cs50Adapter, cs50Course, cs50CourseFor, CS50_CATALOG } from "./cs50.ts";
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

/** Is this reference a web page? */
function isUrl(ref: string): boolean {
	return /^https?:\/\//i.test(ref.trim());
}

/**
 * Find a course's official page for a NAME.
 *
 * The catalogue is asked first (the caller does that); this is the second
 * step — a web search for the course, and the first result that looks like
 * the course's own site. A search engine that is not configured is
 * reported honestly: the answer is "paste the URL", never a guess.
 */
export async function findCoursePage(name: string): Promise<string | null> {
	const provider = searchProvider();
	if (!provider) return null;
	let hits: Awaited<ReturnType<typeof provider.search>>;
	try {
		hits = await provider.search(`${name} course official site`, 8);
	} catch {
		return null;
	}
	for (const hit of hits) {
		const url = hit.url?.trim();
		if (!url || !isUrl(url)) continue;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
		} catch {
			continue;
		}
		return url;
	}
	return null;
}

/**
 * RESOLVE A REFERENCE — a catalogue id, a course URL or a course name —
 * into the course it names.
 *
 * The order is the one the learner would expect:
 *   1. the catalogue (the CS50 family, by id or by title);
 *   2. a URL (the course's own page);
 *   3. a name (the catalogue again by a loose match, then a web search).
 */
export async function resolveCourseRef(ref: string): Promise<ResolvedCourse> {
	const needle = ref.trim();
	if (!needle) throw new Error("No course was named.");

	// 1. the CS50 family, by id, by title or by its own URL.
	const cs50 = cs50CourseFor(needle);
	if (cs50) {
		return {
			courseId: cs50.id,
			ref: needle,
			title: cs50.title,
			source: cs50.source,
			...(cs50.edition ? { edition: cs50.edition } : {}),
			adapter: "cs50",
		};
	}

	// 2. a URL — the course's own page.
	if (isUrl(needle)) {
		const url = needle.startsWith("http") ? needle : `https://${needle}`;
		const id = courseIdForUrl(url);
		return {
			courseId: id,
			ref: needle,
			title: id,
			source: url,
			adapter: adapterFor(url).id,
		};
	}

	// 3. a name. The catalogue by a loose match ("cs50 python", "python")…
	const loose = CS50_CATALOG.find(
		(course) =>
			course.title.toLowerCase().includes(needle.toLowerCase()) ||
			course.id.toLowerCase().includes(needle.toLowerCase().replace(/\s+/g, "")),
	);
	if (loose) {
		return {
			courseId: loose.id,
			ref: needle,
			title: loose.title,
			source: loose.source,
			...(loose.edition ? { edition: loose.edition } : {}),
			adapter: "cs50",
		};
	}

	// …and the web, for everything else.
	const page = await findCoursePage(needle);
	if (!page) {
		throw new Error(
			`No course named "${needle}" is in the catalogue, and no search engine is available to find it. ` +
				"Paste the course's URL instead — any course page works.",
		);
	}
	return {
		courseId: courseIdForUrl(page),
		ref: needle,
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
