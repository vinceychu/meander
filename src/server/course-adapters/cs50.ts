/**
 * THE CS50 ADAPTER — the CS50 family (2026-11-09).
 *
 * Every CS50 course has the SAME site structure (a Jekyll site with a
 * weeks index, a notes page per week, a psets or projects page per week
 * and a spec page per problem), so one adapter covers the whole family:
 *
 *   CS50x  CS50P  CS50AI  CS50W  CS50SQL  CS50R  CS50 Cybersecurity
 *
 * The grading is check50 (`check50 --local <slug>`) and style50, exactly
 * as before — and the slug is READ OFF THE SPEC PAGE, never guessed.
 * A CS50 project that ships no slug (the AI course's projects, for
 * instance) is not pretended to be gradeable: its grader is "none" and
 * the learner submits it himself.
 *
 * The code here is the code that used to live in src/server/courses.ts,
 * moved behind the adapter interface — the behaviour is unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	condenseNotes,
	htmlToMarkdown,
	parseProblemSetPage,
	parseSpecPage,
	parseUnitIndex,
	parseUnitPage,
} from "../../core/course-parse.ts";
import { courseIdFor, type CourseFile, type CourseProblem, type CourseUnit } from "../../core/courses.ts";
import { slugify } from "../../core/course-outline.ts";
import { parseCheckOutput, graderOf, type CourseAdapter, type CourseGrade, type CourseOutline, type CourseRequest } from "../../core/course-adapters.ts";
import { fetchPage } from "../course-pages.ts";
import { runCourseTool } from "../course-tool.ts";
import { downloadDistribution, cloneRepository } from "./starter.ts";

/** One course the CS50 family ships with. */
export interface Cs50Course {
	/** The stable id ("cs50x"). */
	id: string;
	/** The display title. */
	title: string;
	/** Where the course lives (its site). */
	source: string;
	/** The edition label ("2026"). */
	edition?: string;
	/** The page that lists the course's units. */
	indexUrl: string;
	/** A one-line description of what the course is. */
	blurb: string;
}

/**
 * THE CS50 FAMILY — the courses the app ships with. A course is data, not
 * code: adding one is a new entry here, not a new module.
 */
export const CS50_CATALOG: Cs50Course[] = [
	{
		id: "cs50x",
		title: "CS50x",
		source: "https://cs50.harvard.edu/x/",
		edition: "2026",
		indexUrl: "https://cs50.harvard.edu/x/weeks/",
		blurb: "Harvard's introduction to the intellectual enterprises of computer science — C, arrays, algorithms, memory, data structures, Python, HTTP and the web.",
	},
	{
		id: "cs50p",
		title: "CS50's Introduction to Programming with Python",
		source: "https://cs50.harvard.edu/python/",
		edition: "2022",
		indexUrl: "https://cs50.harvard.edu/python/weeks/",
		blurb: "Harvard's introduction to programming with Python — functions, conditionals, loops, exceptions, libraries, unit tests and more.",
	},
	{
		id: "cs50ai",
		title: "CS50's Introduction to AI with Python",
		source: "https://cs50.harvard.edu/ai/",
		edition: "2023",
		indexUrl: "https://cs50.harvard.edu/ai/weeks/",
		blurb: "Harvard's introduction to artificial intelligence with Python — search, knowledge, uncertainty, optimization, learning and neural networks.",
	},
	{
		id: "cs50w",
		title: "CS50's Web Programming with Python and JavaScript",
		source: "https://cs50.harvard.edu/web/",
		edition: "2023",
		indexUrl: "https://cs50.harvard.edu/web/weeks/",
		blurb: "Harvard's introduction to web programming — HTML, CSS, Git, Python, Django, SQL, JavaScript, user interfaces and testing.",
	},
	{
		id: "cs50sql",
		title: "CS50's Introduction to Databases with SQL",
		source: "https://cs50.harvard.edu/sql/",
		edition: "2026",
		indexUrl: "https://cs50.harvard.edu/sql/weeks/",
		blurb: "Harvard's introduction to databases with SQL — querying, relating, designing, writing, viewing, optimizing and scaling.",
	},
	{
		id: "cs50r",
		title: "CS50's Introduction to R for Data Science",
		source: "https://cs50.harvard.edu/r/",
		edition: "2026",
		indexUrl: "https://cs50.harvard.edu/r/weeks/",
		blurb: "Harvard's introduction to R — representing, transforming, tidying and visualizing data, plus testing and packaging programs.",
	},
	{
		id: "cs50cyber",
		title: "CS50's Introduction to Cybersecurity",
		source: "https://cs50.harvard.edu/cybersecurity/",
		edition: "2026",
		indexUrl: "https://cs50.harvard.edu/cybersecurity/weeks/",
		blurb: "Harvard's introduction to cybersecurity — the CIA triad, cryptographic tools, network attacks and defensive tools.",
	},
];

/** The CS50 course of a catalogue id (null when it is not one). */
export function cs50Course(id: string): Cs50Course | null {
	return CS50_CATALOG.find((c) => c.id === id) ?? null;
}

/** The CS50 course a name or URL points at (null when it is not one). */
export function cs50CourseFor(ref: string): Cs50Course | null {
	const needle = ref.trim().toLowerCase();
	if (!needle) return null;
	const byId = CS50_CATALOG.find((c) => c.id === needle);
	if (byId) return byId;
	const byTitle = CS50_CATALOG.find((c) => c.title.toLowerCase() === needle);
	if (byTitle) return byTitle;
	// A CS50 URL: the course's own path ("/x/", "/python/", "/ai/" …).
	const match = /cs50\.harvard\.edu\/([a-z]+)\/?/i.exec(needle);
	if (!match) return null;
	const path = match[1]!.toLowerCase();
	const byPath: Record<string, string> = {
		x: "cs50x",
		python: "cs50p",
		ai: "cs50ai",
		web: "cs50w",
		sql: "cs50sql",
		r: "cs50r",
		cybersecurity: "cs50cyber",
	};
	const id = byPath[path];
	return id ? cs50Course(id) : null;
}

/**
 * The words that name each CS50 course inside the family ("cs50 python").
 *
 * The table is data, like the catalogue itself: a course is named by the
 * words a learner would actually use for it, and by nothing else.
 */
const CS50_KEYWORDS: Record<string, string[]> = {
	cs50x: ["cs50x", "x", "scratch"],
	cs50p: ["cs50p", "python"],
	cs50ai: ["cs50ai", "ai", "artificial"],
	cs50w: ["cs50w", "web", "javascript", "django"],
	cs50sql: ["cs50sql", "sql", "database", "databases"],
	cs50r: ["cs50r", "r"],
	cs50cyber: ["cs50cyber", "cybersecurity", "cyber"],
};

/** The words of a name ("CS50's Introduction to Python" → …). */
function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Does a word name a keyword ("cyber" names "cybersecurity")? */
function namesKeyword(word: string, keyword: string): boolean {
	if (word === keyword) return true;
	if (word.length < 3 || keyword.length < 3) return false;
	return keyword.startsWith(word) || word.startsWith(keyword);
}

/**
 * The CS50 course a LOOSE name points at — null when the name does not
 * really name one.
 *
 * The rule: a loose name has to name the FAMILY ("cs50") to reach the
 * catalogue at all, and one of the family's own keywords picks the course
 * inside it ("cs50 python" is CS50's Python course). A bare "python" or
 * "c" names a LANGUAGE, not a course — it must not land on a CS50 course
 * by accident, so it goes to the web search instead (or nowhere).
 *
 * The family on its own ("cs50") is CS50x, the flagship.
 */
export function looseCs50Course(needle: string): Cs50Course | null {
	const words = wordsOf(needle);
	if (words.length === 0) return null;
	const family = words.find((word) => word.startsWith("cs50"));
	if (!family) return null;
	// The course's own id ("cs50x") names the course outright.
	const byId = CS50_CATALOG.find((course) => course.id === family);
	if (byId) return byId;
	// Inside the family, the keywords pick the course.
	const rest = words.filter((word) => word !== "cs50");
	const scored = CS50_CATALOG.map((course) => ({
		course,
		score: rest.filter((word) => (CS50_KEYWORDS[course.id] ?? []).some((keyword) => namesKeyword(word, keyword))).length,
	}));
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0];
	if (!best || best.score === 0) return cs50Course("cs50x"); // the family alone
	const second = scored[1];
	// Two courses match the name equally well: that is a guess, not a
	// match — the search (or a question) decides, not this table.
	if (second && second.score === best.score) return null;
	return best.course;
}

/** The problem id: a slug of the spec path ("mario/less" → "mario-less"). */
export function problemIdFromPath(specUrl: string, title: string): string {
	let path = specUrl;
	try {
		const url = new URL(specUrl);
		const parts = url.pathname.split("/").filter(Boolean);
		const psets = parts.findIndex((p) => p === "psets" || p === "projects");
		path = psets >= 0 ? parts.slice(psets + 2).join("/") : parts.slice(-2).join("/");
	} catch {
		/* fall through to the title */
	}
	const slug = path
		.split("/")
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || courseIdFor(title);
}

/**
 * The starter files a problem gets: the spec's own starter code (when it
 * ships one), a Makefile for C, and the spec as the README.
 */
export function starterFiles(problem: {
	fileName?: string | null;
	language: string;
	starterCode?: string;
	taskMarkdown: string;
}): CourseFile[] {
	const files: CourseFile[] = [];
	const name = problem.fileName ?? (problem.language === "python" ? "main.py" : problem.language === "sql" ? "main.sql" : "main.txt");
	if (problem.starterCode) {
		files.push({ name, content: problem.starterCode, language: problem.language });
	}
	if (problem.language === "c") {
		const target = name.replace(/\.c$/, "");
		files.push({
			name: "Makefile",
			language: "text",
			content: [
				`CC = gcc`,
				`CFLAGS = -Wall -Wextra -std=c11 -O2 -ggdb3 -fno-common`,
				`LDLIBS = -lcs50 -lm`,
				``,
				`${target}: ${name}`,
				`\t$(CC) $(CFLAGS) -o ${target} ${name} $(LDLIBS)`,
				``,
				`clean:`,
				`\trm -f ${target}`,
				``,
			].join("\n"),
		});
	}
	files.push({
		name: "README.md",
		language: "text",
		content: `# ${problem.fileName ?? "The problem"}\n\n${problem.taskMarkdown}\n`,
	});
	return files;
}

/**
 * THE CS50 ADAPTER — the whole family, one implementation.
 */
export const cs50Adapter: CourseAdapter = {
	id: "cs50",

	detect(ref: string): boolean {
		return cs50CourseFor(ref) !== null || /cs50\.harvard\.edu/i.test(ref);
	},

	async outline(request: CourseRequest): Promise<CourseOutline> {
		const indexHtml = await fetchPage(request.courseId, request.indexUrl ?? request.source);
		const entries = parseUnitIndex(indexHtml, request.indexUrl ?? request.source);
		// The problem ids are the workspace folder names, and the workspace
		// is shared by every course the learner takes. CS50x keeps its own
		// ids exactly as they have always been; the other CS50 courses
		// carry their course's name, so two courses' "hello" never share a
		// folder.
		const prefix = request.courseId === "cs50x" ? "" : `${request.courseId}-`;
		const units: CourseUnit[] = [];
		for (const [index, entry] of entries.entries()) {
			const html = await fetchPage(request.courseId, entry.url);
			const page = parseUnitPage(html, entry.url);
			const id = slugify(page.title || entry.title, `unit-${index + 1}`);
			let notes = "";
			if (page.notesUrl) {
				try {
					const notesHtml = await fetchPage(request.courseId, page.notesUrl);
					notes = htmlToMarkdown(notesHtml);
				} catch {
					notes = "";
				}
			}
			const problems: CourseProblem[] = [];
			// The problems live on the unit's psets page (CS50x, CS50P,
			// CS50SQL, CS50R) or on its projects page (CS50AI, CS50W).
			const problemsUrl = page.psetUrl || page.projectsUrl;
			if (problemsUrl) {
				try {
					const psetHtml = await fetchPage(request.courseId, problemsUrl);
					for (const link of parseProblemSetPage(psetHtml, problemsUrl)) {
						let spec;
						try {
							const specHtml = await fetchPage(request.courseId, link.specUrl);
							spec = parseSpecPage(specHtml, link.specUrl);
						} catch {
							continue; // a spec that will not fetch is skipped, not faked
						}
						const language = spec.language;
						problems.push({
							id: `${prefix}${problemIdFromPath(link.specUrl, spec.title || link.title)}`,
							unitId: id,
							title: spec.title || link.title,
							slug: spec.slug ?? "",
							specUrl: link.specUrl,
							variant: link.variant,
							language,
							distributionUrls: spec.distributionUrls,
							...(spec.videoEmbeds.length > 0 ? { videoEmbeds: spec.videoEmbeds } : {}),
							files: starterFiles({
								fileName: spec.fileName,
								language,
								...(spec.starterCode ? { starterCode: spec.starterCode } : {}),
								taskMarkdown: spec.taskMarkdown,
							}),
							estimateMinutes: 45,
							// The CS50 family grades with check50 — when the
							// spec states a slug. A project that ships none
							// (the AI course's) is honestly "no autograder".
							grader: spec.slug ? "check50" : "none",
						});
					}
				} catch {
					/* no problems for this unit — fine */
				}
			}
			units.push({
				id,
				index,
				title: page.title || entry.title,
				summary: page.summary,
				notesUrl: page.notesUrl,
				pageUrl: entry.url,
				...(page.videoId ? { videoId: page.videoId } : {}),
				lesson: notes ? condenseNotes(notes) : "",
				videos: [],
				estimateMinutes: 60,
				problems,
			});
		}
		return {
			title: request.title,
			source: request.source,
			...(request.edition ? { edition: request.edition } : {}),
			units,
		};
	},

	async problemSpec(request: CourseRequest, problem: CourseProblem): Promise<string> {
		if (!problem.specUrl) return "";
		const html = await fetchPage(request.courseId, problem.specUrl);
		return htmlToMarkdown(html);
	},

	async prepare(request: CourseRequest, problem: CourseProblem, folder: string): Promise<{ created: string[] }> {
		const created: string[] = [];
		fs.mkdirSync(folder, { recursive: true });
		for (const file of problem.files) {
			const target = path.join(folder, file.name);
			if (fs.existsSync(target)) continue;
			// A starter file may name its own folder ("lab01/lab01.py"):
			// the folder is made, and the file is written only when it is
			// not there yet — the learner's file always wins.
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, file.content, "utf-8");
			created.push(file.name);
		}
		// The starter archives the course hands out (the AI course's
		// projects, the CS50x psets that ship a zip). The archive is
		// unpacked into a throwaway folder and only the files the problem
		// does not have yet are copied over — so the second prepare (which
		// happens on every view, run and check) never replaces the
		// learner's work, not even the starter file the spec wrote.
		for (const url of problem.distributionUrls) {
			created.push(...(await downloadDistribution(url, folder)));
		}
		return { created };
	},

	async grade(request: CourseRequest, problem: CourseProblem): Promise<CourseGrade> {
		// A project the course grades by hand (the AI course's) has no
		// grader: saying so is the honest answer, not a fake check.
		if (graderOf(problem) === "none") {
			return {
				ok: false,
				lines: ["[FAIL] this problem has no autograder"],
				passed: 0,
				total: 1,
				causes: ["the course ships no check50 slug for this problem — read the spec and answer in the chat"],
				grader: "none",
				output: "[FAIL] this problem has no autograder — the course ships no check50 slug for it.",
			};
		}
		const result = await runCourseTool(`check ${problem.id}`);
		const verdict = parseCheckOutput(result.output);
		const lines = result.output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^\[(ok|FAIL)\]/.test(line));
		return {
			ok: verdict.total > 0 && verdict.failed.length === 0,
			lines,
			passed: verdict.passed,
			total: verdict.total,
			causes: verdict.failed,
			grader: "check50",
			output: result.output,
		};
	},
};
