/**
 * THE COURSE PAGE CACHE — the fetch + the disk cache (2026-11-09).
 *
 * Every page a course reads goes through here: the syllabus, the notes,
 * the problem specs and (for a generic course) the whole crawl. The cache
 * is the offline story — a course keeps working when the site is down (or
 * the machine is offline), and a re-read costs no network.
 *
 * It lives in its own module because both the course service
 * (src/server/courses.ts) and the course adapters need it, and one module
 * importing both would be a cycle.
 */

import { readCachedPage, writeCachedPage } from "../store/courses.ts";

const FETCH_TIMEOUT_MS = 30_000;

/** Fetch a page and cache it under the course's folder.
 *
 *  The cache is the offline story: the syllabus, the notes and the problem
 *  specs are re-readable from disk with no network, so a course keeps
 *  working when the site is down (or the machine is offline). */
export async function fetchPage(courseId: string, url: string): Promise<string> {
	const cached = readCachedPage(courseId, url);
	if (cached !== null) return cached;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "Meander (course fetch)" },
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
		const html = await response.text();
		writeCachedPage(courseId, url, html);
		return html;
	} finally {
		clearTimeout(timer);
	}
}

/** The cached page for a URL, or null. */
export function cachedPage(courseId: string, url: string): string | null {
	return readCachedPage(courseId, url);
}
