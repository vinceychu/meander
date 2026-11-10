/**
 * THE GENERIC ADAPTER — any course page (2026-11-09).
 *
 * The fallback for every course nobody has written an adapter for: a
 * course URL (MIT OCW, CS61A, The Odin Project, a course's GitHub repo,
 * a public syllabus).
 *
 * The flow:
 *   1. CRAWL the page the learner gave (+ the syllabus/schedule pages it
 *      links, same host, depth ≤ 2, ≤ 60 pages, cached on disk).
 *   2. EXTRACT the outline with the model (the cheap slot) — validated
 *      against a schema, and every URL it names must be one the crawl
 *      saw. An invented URL is rejected.
 *   3. PREPARE the problem's folder: the starter code from the spec, the
 *      archive the course hands out, or its repository (cloned shallow).
 *   4. GRADE the work: the course's own autograder or test suite when it
 *      ships one, the rubric when it does not.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runSubmitAgent } from "../../agent/subagents/submit-agent.ts";
import { condenseNotes, extractCheckSlug, htmlToMarkdown } from "../../core/course-parse.ts";
import { crawlCourse, pagesForModel, type CrawledPage } from "../../core/course-crawl.ts";
import { detectGrader } from "../../core/course-graders.ts";
import {
	extractOutline,
	isWebUrl,
	normalizeGrader,
	normalizeLanguage,
	OUTLINE_SYSTEM_PROMPT,
	outlineSchema,
	resolveAgainst,
	slugify,
	videoStartSeconds,
	youtubeIdInUrl,
	type OutlineDraft,
	type OutlineModel,
} from "../../core/course-outline.ts";
import type { CourseAdapter, CourseGrade, CourseOutline, CourseRequest } from "../../core/course-adapters.ts";
import { graderOf } from "../../core/course-adapters.ts";
import { courseIdFor, type CourseProblem, type CourseUnit, type CourseVideoSegment } from "../../core/courses.ts";
import type { PiEngine } from "../../agent/models.ts";
import { fetchPage } from "../course-pages.ts";
import { runCourseTool } from "../course-tool.ts";
import { runCommandGrader, runRubricGrader } from "./grading.ts";
import { engineForRole } from "./model.ts";
import { cloneRepository, downloadDistribution } from "./starter.ts";

/** The seams the generic adapter runs on (the tests replace them). */
export interface GenericAdapterOptions {
	/** The model that reads the pages. */
	model?: OutlineModel;
	/** The page fetcher (the app's caching one; a test passes its fixtures). */
	fetch?: (courseId: string, url: string) => Promise<string>;
}

/**
 * The outline the model submits (the seam the tests drive).
 *
 * The LAWS the extraction runs under travel as the SYSTEM prompt: the URL
 * law (only URLs the crawl saw) and "the problems are the assignments the
 * course asks for". Without them the model answers with whatever shape
 * the pages happen to show — a schedule, a table of lectures — and the
 * course comes out with no problems at all.
 */
export async function outlineAnswer(engine: PiEngine, prompt: string): Promise<string> {
	const draft = await runSubmitAgent({
		role: "extractor",
		toolName: "submit_outline",
		toolDescription: "Submit the course outline extracted from the course's pages.",
		parameters: outlineSchema,
		fill: (input: unknown) => input as OutlineDraft,
		systemPrompt: OUTLINE_SYSTEM_PROMPT,
		prompt,
		engine,
		signal: undefined,
		onStep: () => {},
		neverSubmitted: "The model did not submit a course outline.",
		maxTurns: 3,
	});
	return JSON.stringify(draft);
}

/** The model seam: the app's background extraction path (the cheap slot). */
export async function defaultOutlineModel(prompt: string): Promise<string> {
	const engine = engineForRole("extractor");
	if (!engine) {
		throw new Error("no model is configured for reading a course (settings → models → cheap slot)");
	}
	return outlineAnswer(engine, prompt);
}

/** The first paragraph of a page's text (a unit's summary, when the model gave none). */
function firstParagraph(text: string): string {
	const paragraph = text.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part.length > 20);
	return (paragraph ?? "").split("\n")[0]?.trim().slice(0, 400) ?? "";
}

/** The starter files a generic problem gets (the spec as the README). */
function starterFiles(title: string, spec: string): Array<{ name: string; content: string; language: string }> {
	return [
		{
			name: "README.md",
			language: "text",
			content: `# ${title}\n\n${spec}\n`,
		},
	];
}

/**
 * The starter archive a spec page links — the course's own download.
 *
 * The link is a fact on the page, so it does not depend on the model
 * noticing it: every assignment page links its own starter zip. The
 * solutions are never taken (a course that publishes them is not the
 * learner's to open).
 */
function starterArchiveFrom(page: CrawledPage | undefined): string {
	if (!page) return "";
	for (const link of page.links) {
		const href = (link.href ?? "").split("#")[0] ?? "";
		if (!/\.(zip|tar\.gz|tgz)(\?|$)/i.test(href)) continue;
		if (/solution/i.test(href)) continue;
		return resolveAgainst(href, page.url);
	}
	return "";
}

/** The starter repository a spec page links (GitHub). */
function repoFrom(page: CrawledPage | undefined): string {
	if (!page) return "";
	for (const link of page.links) {
		const href = (link.href ?? "").split("#")[0] ?? "";
		if (!href) continue;
		const url = resolveAgainst(href, page.url);
		if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(url)) return url;
	}
	return "";
}

/** The grader a problem's spec implies (the model's word, else the spec's). */
function graderFor(draftGrader: string | undefined, specText: string): "check50" | "autograder" | "tests" | "ai-rubric" | "none" {
	const stated = normalizeGrader(draftGrader);
	if (stated) return stated;
	const text = specText.toLowerCase();
	if (/check50\s+cs50\/problems\//.test(text)) return "check50";
	if (/\bok\s+--local\b/.test(text)) return "autograder";
	if (/pytest/.test(text)) return "tests";
	if (/npm (run )?test/.test(text)) return "tests";
	if (/make test/.test(text)) return "tests";
	// Nothing says how this problem is graded: the AI reviews it (the
	// course's own files may still give away a grader later — prepare
	// records it).
	return "ai-rubric";
}

/** Build the course's units from the extracted outline. */
function unitsFromDraft(
	draft: OutlineDraft,
	request: CourseRequest,
	pages: Map<string, CrawledPage>,
): CourseUnit[] {
	const usedIds = new Set<string>();
	const uniqueId = (base: string): string => {
		let id = base;
		let counter = 2;
		while (usedIds.has(id)) id = `${base}-${counter++}`;
		usedIds.add(id);
		return id;
	};
	return draft.units.map((unit, index) => {
		const id = uniqueId(slugify(unit.title, `unit-${index + 1}`));
		const page = unit.pageUrl ? pages.get(unit.pageUrl.replace(/\/+$/, "")) : undefined;
		const notesPage = unit.notesUrls?.[0] ? pages.get(unit.notesUrls[0].replace(/\/+$/, "")) : undefined;
		const notesUrl = unit.notesUrls?.[0] ?? "";
		const summary = unit.summary?.trim() || (page ? firstParagraph(page.text) : "");
		// The videos: only the ones whose URL carries a YouTube id, and
		// only a timestamp the URL itself states.
		const videos: CourseVideoSegment[] = [];
		for (const video of unit.videos ?? []) {
			const url = video.url ?? "";
			const youtubeId = video.youtubeId ?? (url ? youtubeIdInUrl(url) : undefined);
			if (!youtubeId) continue;
			const startSeconds = videoStartSeconds(video);
			videos.push({
				title: video.title,
				youtubeId,
				...(startSeconds !== undefined ? { startSeconds } : {}),
			});
		}
		const problems: CourseProblem[] = [];
		for (const problem of unit.problems ?? []) {
			const specUrl = problem.specUrl ?? "";
			const specPage = specUrl ? pages.get(specUrl.replace(/\/+$/, "")) : undefined;
			const specText = specPage ? specPage.markdown : "";
			const slug = extractCheckSlug(specPage?.text ?? "") ?? "";
			const problemId = uniqueId(`${request.courseId}-${slugify(problem.title, "problem")}`);
			// The starter code: what the assignment page itself links (the
			// course's own download), else what the model named.
			const starterUrl = starterArchiveFrom(specPage) || problem.starterUrl || "";
			const repoUrl = repoFrom(specPage) || problem.repoUrl || "";
			problems.push({
				id: problemId,
				unitId: id,
				title: problem.title,
				slug,
				specUrl,
				variant: "standard",
				language: normalizeLanguage(problem.language ?? specPage?.text.slice(0, 2000)),
				distributionUrls: starterUrl ? [starterUrl] : [],
				...(repoUrl ? { repoUrl } : {}),
				files: starterFiles(problem.title, specText || `The assignment: ${specUrl}`),
				estimateMinutes: 45,
				grader: graderFor(problem.grader, specText),
			});
		}
		return {
			id,
			index,
			title: unit.title,
			summary,
			notesUrl,
			...(unit.pageUrl ? { pageUrl: unit.pageUrl } : {}),
			...(videos[0] ? { videoId: videos[0].youtubeId } : {}),
			lesson: notesPage ? condenseNotes(notesPage.markdown) : "",
			videos,
			estimateMinutes: 60,
			problems,
		};
	});
}

/**
 * THE GENERIC ADAPTER — any course page.
 */
export function createGenericAdapter(opts: GenericAdapterOptions = {}): CourseAdapter {
	const model = opts.model ?? defaultOutlineModel;
	const fetchPageFor = opts.fetch ?? ((courseId: string, url: string) => fetchPage(courseId, url));
	/** The spec of a problem (the markdown the learner reads). */
	const specOf = async (request: CourseRequest, problem: CourseProblem): Promise<string> => {
		if (!problem.specUrl) return "";
		try {
			const html = await fetchPageFor(request.courseId, problem.specUrl);
			return htmlToMarkdown(html);
		} catch {
			return "";
		}
	};
	return {
		id: "generic",

		detect(ref: string): boolean {
			// Any web page is a course page — with or without its scheme
			// ("cs61a.org" is a URL a learner pastes).
			return isWebUrl(ref);
		},

		async outline(request: CourseRequest): Promise<CourseOutline> {
			const crawl = await crawlCourse(request.source, (url) => fetchPageFor(request.courseId, url));
			if (crawl.pages.length === 0) {
				throw new Error(
					`the course page could not be read: ${crawl.problems[0] ?? request.source}`,
				);
			}
			const pages = pagesForModel(crawl.pages);
			const extraction = await extractOutline(pages, crawl.allowedUrls, model);
			if (!extraction.ok) {
				throw new Error(
					`the course's outline could not be read from its pages:\n${extraction.problems.map((problem) => `- ${problem}`).join("\n")}`,
				);
			}
			const byUrl = new Map(crawl.pages.map((page) => [page.url.replace(/\/+$/, ""), page]));
			return {
				// The course's own name, as its pages state it — the folder
				// name ("cs61a-org") is only a placeholder.
				title: extraction.draft.title || request.title,
				source: request.source,
				...(request.edition ? { edition: request.edition } : {}),
				units: unitsFromDraft(extraction.draft, request, byUrl),
			};
		},

		async problemSpec(request: CourseRequest, problem: CourseProblem): Promise<string> {
			return specOf(request, problem);
		},

		async prepare(
			request: CourseRequest,
			problem: CourseProblem,
			folder: string,
		): Promise<{ created: string[]; grader?: "autograder" | "tests"; graderCommand?: string; graderWorkDir?: string }> {
			const created: string[] = [];
			fs.mkdirSync(folder, { recursive: true });
			for (const file of problem.files) {
				const target = path.join(folder, file.name);
				if (fs.existsSync(target)) continue;
				// A course that hands its lab out in a subfolder ("lab01/")
				// names the file with its folder: the folder is made, and the
				// file is written only when it is not there yet — the
				// learner's file always wins.
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, file.content, "utf-8");
				created.push(file.name);
			}
			// The starter code: the course's archive, or its repository.
			for (const url of problem.distributionUrls) {
				created.push(...(await downloadDistribution(url, folder)));
			}
			if (problem.repoUrl) {
				created.push(...(await cloneRepository(problem.repoUrl, folder)));
			}
			// The grader the course's own files give away (an `ok` client,
			// a test suite). The course's files are the truth about HOW it
			// is graded, so the command is always recorded; but a grader
			// the course itself stated (check50) is never overruled.
			const stated = graderOf(problem);
			const detected = detectGrader(listFiles(folder));
			if (detected && stated !== "check50") {
				const rubricish = stated === "none" || stated === "ai-rubric";
				return {
					created,
					...(rubricish ? { grader: detected.grader === "autograder" ? "autograder" : "tests" } : {}),
					graderCommand: detected.graderCommand,
					graderWorkDir: detected.workDir,
				};
			}
			return { created };
		},

		async grade(request: CourseRequest, problem: CourseProblem, folder: string): Promise<CourseGrade> {
			const kind = graderOf(problem);
			if (kind === "none") {
				return {
					ok: false,
					lines: ["[FAIL] this problem has no autograder"],
					passed: 0,
					total: 1,
					causes: ["the course ships no grader for this problem — read the spec and answer in the chat"],
					grader: "none",
					output: "[FAIL] this problem has no autograder — the course ships no grader for it.",
				};
			}
			if (kind === "check50") {
				const result = await runCourseTool(`check ${problem.id}`);
				const lines = result.output
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => /^\[(ok|FAIL)\]/.test(line));
				const passed = lines.filter((line) => line.startsWith("[ok]")).length;
				const total = lines.length;
				return {
					ok: total > 0 && passed === total,
					lines,
					passed,
					total,
					causes: lines.filter((line) => line.startsWith("[FAIL]")).map((line) => line.replace(/^\[FAIL\]\s*/, "")),
					grader: "check50",
					output: result.output,
				};
			}
			if (kind === "tests" || kind === "autograder") {
				const detected = detectGrader(listFiles(folder));
				const command = problem.graderCommand ?? detected?.graderCommand ?? "";
				if (!command) {
					return {
						ok: false,
						lines: ["[FAIL] the course's test command is unknown"],
						passed: 0,
						total: 1,
						causes: ["no test suite in the problem's folder"],
						grader: kind,
						output: "the course's test command is unknown",
					};
				}
				// The command runs where the course's code lives (a lab in a
				// subfolder), with the course's own environment.
				const workDir = problem.graderWorkDir ?? detected?.workDir ?? "";
				return runCommandGrader(command, folder, kind, { workDir });
			}
			// The rubric: the tutor reads the work against the assignment.
			const spec = await specOf(request, problem);
			return runRubricGrader({
				problem,
				folder,
				spec: spec || problem.files.find((f) => f.name === "README.md")?.content || "",
			});
		},
	};
}

/**
 * The file names a folder holds, relative and "/" separated.
 *
 * Recursive (a course that hands out its lab in a subfolder keeps its
 * test suite in another one), but hidden folders are skipped: they hold
 * the course's vendored tooling, not the learner's code.
 */
function listFiles(folder: string, depth = 0): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			out.push(`${entry.name}/`);
			if (depth < 4) {
				for (const child of listFiles(path.join(folder, entry.name), depth + 1)) {
					out.push(`${entry.name}/${child}`);
				}
			}
			continue;
		}
		out.push(entry.name);
	}
	return out;
}

/** The production generic adapter. */
export const genericAdapter: CourseAdapter = createGenericAdapter();

/** The course id a URL gets (the folder name). */
export function courseIdForUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^www\./, "");
		const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
		return courseIdFor(`${host}${first ? `-${first}` : ""}`);
	} catch {
		return courseIdFor(url);
	}
}
