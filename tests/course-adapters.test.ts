/**
 * THE COURSE ADAPTERS (2026-11-09) — "learn ANY course".
 *
 * Four laws are pinned here, and they are the point of the seam:
 *
 *   1. DETECTION — a reference names one adapter: the CS50 family for the
 *      CS50 courses (by id, by title, by their own URL), the generic
 *      adapter for every other course page.
 *   2. THE URL LAW — every URL in an extracted outline must be one the
 *      crawl SAW. A model that invents "https://example.edu/labs/lab99.html"
 *      has that URL DROPPED — the course is kept, the invented link is not.
 *   3. THE GRADER — a course's own grader is preferred over anything else
 *      (`ok` first, then the test suite), and a course that ships none says
 *      so instead of faking a check.
 *   4. THE STARTER — the course's own archive and repository are unpacked
 *      and cloned, and neither ever overwrites or deletes the learner's work.
 *
 * The CS50 fixtures are trimmed copies of the real pages (fetched
 * 2026-11-09); the generic course is a hand-written fake site (see
 * tests/fixtures/generic-course/), so nothing here touches the network.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { parseProblemSetPage, parseSpecPage, parseUnitIndex, parseUnitPage } from "../src/core/course-parse.ts";
import { detectGrader, checksToLines, parseTestOutput, summaryLine } from "../src/core/course-graders.ts";
import { graderLabel, graderOf } from "../src/core/course-adapters.ts";
import type { CrawledPage } from "../src/core/course-crawl.ts";
import { allowedUrlSet, asWebUrl, extractOutline, isWebUrl, looksLikeCoursePage, stripInventedUrls } from "../src/core/course-outline.ts";
import type { CourseRequest } from "../src/core/courses.ts";
import { adapterFor, findCoursePage, resolveCourseRef } from "../src/server/course-adapters/index.ts";
import { cs50Adapter, cs50CourseFor, looseCs50Course, problemIdFromPath } from "../src/server/course-adapters/cs50.ts";
import { createGenericAdapter, courseIdForUrl, genericAdapter, outlineAnswer } from "../src/server/course-adapters/generic.ts";
import { cloneRepository } from "../src/server/course-adapters/starter.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");

// ─── 1. detection ──────────────────────────────────────────────────────────

describe("which adapter handles a reference", () => {
	it("gives the CS50 family to the CS50 adapter", () => {
		assert.equal(cs50Adapter.detect("cs50x"), true);
		assert.equal(cs50Adapter.detect("cs50p"), true);
		assert.equal(cs50Adapter.detect("https://cs50.harvard.edu/python/"), true);
		assert.equal(cs50Adapter.detect("https://cs50.harvard.edu/ai/"), true);
		assert.equal(cs50Adapter.detect("CS50's Introduction to Programming with Python"), true);
	});

	it("gives every other course page to the generic adapter", () => {
		assert.equal(genericAdapter.detect("https://cs61a.org/"), true);
		assert.equal(genericAdapter.detect("http://ocw.mit.edu/"), true);
		assert.equal(genericAdapter.detect("cs50x"), false, "a catalogue id is not a URL");
	});

	it("routes by reference, with the generic one as the fallback", () => {
		assert.equal(adapterFor("cs50x").id, "cs50");
		assert.equal(adapterFor("https://cs50.harvard.edu/web/").id, "cs50");
		assert.equal(adapterFor("https://cs61a.org/").id, "generic");
		assert.equal(adapterFor("https://cs61a.org/").id, "generic");
	});

	it("knows every CS50 course by its own path", () => {
		const expected: Array<[string, string]> = [
			["https://cs50.harvard.edu/x/", "cs50x"],
			["https://cs50.harvard.edu/python/", "cs50p"],
			["https://cs50.harvard.edu/ai/", "cs50ai"],
			["https://cs50.harvard.edu/web/", "cs50w"],
			["https://cs50.harvard.edu/sql/", "cs50sql"],
			["https://cs50.harvard.edu/r/", "cs50r"],
			["https://cs50.harvard.edu/cybersecurity/", "cs50cyber"],
		];
		for (const [url, id] of expected) {
			assert.equal(cs50CourseFor(url)?.id, id, url);
		}
	});

	it("resolves a reference to the course it names", async () => {
		const byId = await resolveCourseRef("cs50p");
		assert.equal(byId.courseId, "cs50p");
		assert.equal(byId.adapter, "cs50");
		assert.equal(byId.source, "https://cs50.harvard.edu/python/");

		const byUrl = await resolveCourseRef("https://cs61a.org/");
		assert.equal(byUrl.adapter, "generic");
		assert.equal(byUrl.source, "https://cs61a.org/");
		assert.equal(byUrl.courseId, courseIdForUrl("https://cs61a.org/"));
		assert.equal(byUrl.courseId, "cs61a-org");
	});
});

// ─── 2. the CS50 family (CS50P and CS50AI) ─────────────────────────────────

describe("the CS50 family reads CS50P's pages", () => {
	const INDEX = "https://cs50.harvard.edu/python/weeks/";
	const PSET = "https://cs50.harvard.edu/python/psets/0/";

	it("reads the units off the index", () => {
		const units = parseUnitIndex(read("cs50p-weeks-index.html"), INDEX);
		assert.equal(units.length, 10);
		assert.equal(units[0]?.url, "https://cs50.harvard.edu/python/weeks/0/");
		assert.equal(units[0]?.title, "Functions, Variables");
	});

	it("reads the notes, the problem set and the lecture", () => {
		const week = parseUnitPage(read("cs50p-week0.html"), "https://cs50.harvard.edu/python/weeks/0/");
		assert.equal(week.title, "Week 0 Functions");
		assert.equal(week.notesUrl, "https://cs50.harvard.edu/python/notes/0/");
		assert.equal(week.psetUrl, "https://cs50.harvard.edu/python/psets/0/");
		assert.equal(week.videoId, "JP7ITIXGpHk");
	});

	it("reads the problem set's problems", () => {
		const problems = parseProblemSetPage(read("cs50p-pset0.html"), PSET);
		const titles = problems.map((p) => p.title);
		assert.ok(titles.includes("Indoor Voice"));
		assert.ok(titles.includes("Tip Calculator"));
		assert.equal(problems[0]?.specUrl, "https://cs50.harvard.edu/python/psets/0/indoor/");
	});

	it("reads the check50 slug off the spec — never guessed", () => {
		const spec = parseSpecPage(read("cs50p-indoor.html"), "https://cs50.harvard.edu/python/psets/0/indoor/");
		assert.equal(spec.slug, "cs50/problems/2022/python/indoor");
		assert.equal(spec.fileName, "indoor.py");
		assert.equal(spec.folderName, "indoor");
		assert.equal(spec.language, "python");
	});

	it("names the problem's folder the way CS50 does", () => {
		assert.equal(problemIdFromPath("https://cs50.harvard.edu/python/psets/0/indoor/", "Indoor Voice"), "indoor");
	});
});

describe("the CS50 family reads CS50AI's pages", () => {
	it("finds the PROJECTS page, not a problem set", () => {
		const week = parseUnitPage(read("cs50ai-week0.html"), "https://cs50.harvard.edu/ai/weeks/0/");
		assert.equal(week.title, "Week 0 Search");
		assert.equal(week.psetUrl, "", "the AI course has no psets page");
		assert.equal(week.projectsUrl, "https://cs50.harvard.edu/ai/projects/0/");
	});

	it("reads the project's problems", () => {
		const problems = parseProblemSetPage(read("cs50ai-projects0.html"), "https://cs50.harvard.edu/ai/projects/0/");
		const titles = problems.map((p) => p.title);
		assert.ok(titles.includes("Degrees"));
		assert.ok(titles.includes("Tic-Tac-Toe"));
	});

	it("is honest about a project that ships no check50 slug", () => {
		const spec = parseSpecPage(read("cs50ai-tictactoe.html"), "https://cs50.harvard.edu/ai/projects/0/tictactoe/");
		assert.equal(spec.slug, null, "the AI project is not graded by check50");
		assert.deepEqual(spec.distributionUrls, ["https://cdn.cs50.net/ai/2023/x/projects/0/tictactoe.zip"]);
		// No slug means no grader — the course page says so rather than
		// pretending there is an autograder.
		assert.equal(graderOf({ slug: spec.slug ?? "", grader: spec.slug ? "check50" : "none" }), spec.slug ? "check50" : "none");
		assert.equal(graderLabel({ grader: "none" }), "No autograder");
	});
});

// ─── 3. the generic adapter (the crawl + the outline) ───────────────────────

/** The fake course site's pages (the fixtures the crawl reads). */
const GENERIC = path.join(FIXTURES, "generic-course");
const GENERIC_HOME = "https://example.edu/course/";

/** A fetcher that serves the fake site and 404s everything else. */
function fakeFetch(_courseId: string, url: string): Promise<string> {
	const name = url.startsWith(GENERIC_HOME) ? url.slice(GENERIC_HOME.length) : "";
	// The site's home page is the seed itself.
	const file = path.join(GENERIC, name === "" ? "home.html" : name);
	if (fs.existsSync(file) && fs.statSync(file).isFile()) {
		return Promise.resolve(fs.readFileSync(file, "utf-8"));
	}
	return Promise.reject(new Error(`404: ${url}`));
}

const REQUEST: CourseRequest = {
	courseId: "widgets",
	ref: GENERIC_HOME,
	source: GENERIC_HOME,
	title: "Introduction to Widgets",
};

/** The model the tests use: it answers with the outline it is given. */
function modelAnswering(draft: unknown): (prompt: string) => Promise<string> {
	return () => Promise.resolve(JSON.stringify(draft));
}

/** The outline the fake model returns when everything is honest. */
const HONEST_OUTLINE = {
	title: "Introduction to Widgets",
	units: [
		{
			title: "Unit 1: Widgets",
			summary: "How widgets are made.",
			pageUrl: "https://example.edu/course/syllabus.html",
			notesUrls: ["https://example.edu/course/notes/unit1.html"],
			problems: [
				{
					title: "Lab 1: Widgets",
					specUrl: "https://example.edu/course/labs/lab01.html",
					starterUrl: "https://example.edu/labs/lab01.zip",
					repoUrl: "https://github.com/example/lab01",
					language: "Python",
					grader: "autograder",
				},
			],
		},
	],
};

describe("the generic adapter reads a course nobody wrote an adapter for", () => {
	it("crawls the course's own pages and extracts the outline", async () => {
		const adapter = createGenericAdapter({ model: modelAnswering(HONEST_OUTLINE), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		assert.equal(outline.title, "Introduction to Widgets");
		assert.equal(outline.units.length, 1);
		const unit = outline.units[0]!;
		assert.equal(unit.title, "Unit 1: Widgets");
		assert.equal(unit.problems.length, 1);
		const problem = unit.problems[0]!;
		assert.equal(problem.title, "Lab 1: Widgets");
		assert.equal(problem.language, "python");
		assert.equal(problem.grader, "autograder");
		assert.equal(problem.specUrl, "https://example.edu/course/labs/lab01.html");
		assert.deepEqual(problem.distributionUrls, ["https://example.edu/labs/lab01.zip"]);
		assert.equal(problem.repoUrl, "https://github.com/example/lab01");
	});

	it("never follows a link off the course's own host", async () => {
		const seen: string[] = [];
		const adapter = createGenericAdapter({
			model: modelAnswering(HONEST_OUTLINE),
			fetch: (courseId, url) => {
				seen.push(url);
				return fakeFetch(courseId, url);
			},
		});
		await adapter.outline(REQUEST);
		for (const url of seen) {
			assert.equal(new URL(url).host, "example.edu", "the crawl stays on the course's host");
		}
	});

	it("DROPS an invented URL — and keeps the course", async () => {
		const inventing = {
			title: "Introduction to Widgets",
			units: [
				{
					title: "Unit 1: Widgets",
					problems: [
						{
							title: "Lab 1: Widgets",
							specUrl: "https://example.edu/course/labs/lab99.html",
						},
					],
				},
			],
		};
		const adapter = createGenericAdapter({ model: modelAnswering(inventing), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		assert.equal(outline.units.length, 1, "one invented link must not cost the learner the course");
		assert.deepEqual(
			outline.units[0]!.problems,
			[],
			"the problem whose spec page was invented went with it",
		);
	});

	it("DROPS an invented notes URL too", async () => {
		const inventing = {
			title: "Introduction to Widgets",
			units: [
				{
					title: "Unit 1: Widgets",
					notesUrls: ["https://example.edu/course/notes/unit7.html"],
				},
			],
		};
		const adapter = createGenericAdapter({ model: modelAnswering(inventing), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		assert.equal(outline.units.length, 1);
		assert.equal(outline.units[0]!.notesUrl, "", "the invented notes page is not in the course");
	});

	it("keeps the problems the crawl really saw", async () => {
		const mixed = {
			title: "Introduction to Widgets",
			units: [
				{
					title: "Unit 1: Widgets",
					problems: [
						{ title: "Lab 1: Widgets", specUrl: "https://example.edu/course/labs/lab01.html" },
						{ title: "Lab 99: Ghosts", specUrl: "https://example.edu/course/labs/lab99.html" },
					],
				},
			],
		};
		const adapter = createGenericAdapter({ model: modelAnswering(mixed), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		const problems = outline.units[0]!.problems;
		assert.equal(problems.length, 1);
		assert.equal(problems[0]!.title, "Lab 1: Widgets");
	});

	it("says so when the model's answer is not an outline at all", async () => {
		const adapter = createGenericAdapter({ model: () => Promise.resolve("I could not read the course."), fetch: fakeFetch });
		await assert.rejects(() => adapter.outline(REQUEST), /did not answer with a course outline/);
	});

	it("says so when the course page cannot be read at all", async () => {
		const adapter = createGenericAdapter({
			model: modelAnswering(HONEST_OUTLINE),
			fetch: () => Promise.reject(new Error("404")),
		});
		await assert.rejects(() => adapter.outline(REQUEST), /could not be read/);
	});

	it("grades a problem the course gives no grader honestly", async () => {
		const adapter = createGenericAdapter({ model: modelAnswering(HONEST_OUTLINE), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		const problem = { ...outline.units[0]!.problems[0]!, grader: "none" as const };
		const grade = await adapter.grade(REQUEST, problem, "/tmp/does-not-matter");
		assert.equal(grade.ok, false);
		assert.equal(grade.grader, "none");
		assert.match(grade.lines[0] ?? "", /no autograder/);
	});
});

// ─── 4. the graders ────────────────────────────────────────────────────────

describe("which grader a course's own files give away", () => {
	it("prefers the course's own autograder (the `ok` client)", () => {
		const detected = detectGrader(["ok", "lab01/__init__.py", "README.md"]);
		assert.equal(detected?.grader, "autograder");
		assert.equal(detected?.graderCommand, "python3 ok --local");
	});

	it("falls back to pytest when the course ships a test suite", () => {
		assert.equal(detectGrader(["tests/test_widgets.py"])?.graderCommand, "python3 -m pytest -v");
		assert.equal(detectGrader(["test_widgets.py"])?.graderCommand, "python3 -m pytest -v");
	});

	it("knows the other test runners", () => {
		assert.equal(detectGrader(["package.json"])?.graderCommand, "npm test --silent");
		assert.equal(detectGrader(["Makefile"])?.graderCommand, "make test");
		assert.equal(detectGrader(["Cargo.toml"])?.graderCommand, "cargo test");
		assert.equal(detectGrader(["go.mod"])?.graderCommand, "go test ./...");
	});

	it("prefers the autograder over the tests when both are there", () => {
		const detected = detectGrader(["ok", "tests/test_widgets.py"]);
		assert.equal(detected?.grader, "autograder");
	});

	it("finds nothing in a folder with no grader — the rubric then grades it", () => {
		assert.equal(detectGrader(["README.md", "main.py"]), null);
		assert.equal(graderLabel({ grader: "ai-rubric" }), "AI-reviewed");
	});

	it("knows WHERE the grader runs — the folder the course's code lives in", () => {
		// A course that hands its lab out in a subfolder grades inside it.
		assert.equal(detectGrader(["lab01/tests/python_basics.py", "lab01/lab01.py"])?.workDir, "lab01");
		assert.equal(detectGrader(["lab01/ok"])?.workDir, "lab01");
		assert.equal(detectGrader(["ok"])?.workDir, "", "a file at the top grades in the problem's folder");
		assert.equal(detectGrader(["tests/test_widgets.py"])?.workDir, "");
	});
});

describe("the generic adapter finds the course's own grader", () => {
	it("sees a test suite in a subfolder and says where it runs", async () => {
		const adapter = createGenericAdapter({ model: modelAnswering(HONEST_OUTLINE), fetch: fakeFetch });
		const outline = await adapter.outline(REQUEST);
		const problem = { ...outline.units[0]!.problems[0]!, grader: "none" as const };
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-generic-"));
		fs.mkdirSync(path.join(folder, "lab01", "tests"), { recursive: true });
		fs.writeFileSync(path.join(folder, "lab01", "tests", "test_widgets.py"), "def test_x():\n    pass\n", "utf-8");
		const prepared = await adapter.prepare(REQUEST, problem, folder);
		assert.equal(prepared.grader, "tests");
		assert.equal(prepared.graderCommand, "python3 -m pytest -v");
		assert.equal(prepared.graderWorkDir, "lab01", "the grader runs in the folder the course's code lives in");
	});
});

describe("reading a test runner's output", () => {
	it("reads pytest's lines", () => {
		const checks = parseTestOutput(
			["tests/test_widgets.py::test_makes_a_widget PASSED   [ 50%]", "tests/test_widgets.py::test_counts FAILED  [100%]"].join("\n"),
		);
		assert.equal(checks.length, 2);
		assert.equal(checks[0]?.ok, true);
		assert.equal(checks[1]?.ok, false);
		const lines = checksToLines(checks);
		assert.match(lines[0] ?? "", /^\[ok\]/);
		assert.match(lines[1] ?? "", /^\[FAIL\]/);
		assert.equal(summaryLine(1, 2), "1/2 checks passed");
	});

	it("reads go's and cargo's lines", () => {
		const go = parseTestOutput("--- PASS: TestWidget (0.00s)\n--- FAIL: TestGadget (0.01s)");
		assert.equal(go[0]?.ok, true);
		assert.equal(go[1]?.ok, false);
		const cargo = parseTestOutput("test widgets::makes_a_widget ... ok\ntest widgets::counts ... FAILED");
		assert.equal(cargo[0]?.ok, true);
		assert.equal(cargo[1]?.ok, false);
	});

	it("reads jest's and vitest's marks", () => {
		const checks = parseTestOutput("✓ makes a widget\n✕ counts widgets");
		assert.equal(checks[0]?.ok, true);
		assert.equal(checks[1]?.ok, false);
	});

	it("does not read pytest's summary line as a test", () => {
		const checks = parseTestOutput(
			[
				"lab01.py::lab01.pick_digit PASSED                    [ 62%]",
				"========================= 6 passed, 2 skipped in 0.02s =========================",
			].join("\n"),
		);
		assert.equal(checks.length, 1, "the summary line is not a check");
		assert.equal(checks[0]?.name, "lab01.py::lab01.pick_digit");
	});

	it("carries the assertion a failure tripped over", () => {
		const checks = parseTestOutput(
			[
				"tests/test_widgets.py::test_counts FAILED              [100%]",
				"=================================== FAILURES ===================================",
				"____________________________________ test_counts _____________________________________",
				"    def test_counts():",
				">       assert make_widget() == 2",
				"E       assert 1 == 2",
				"=========================== short test summary info ============================",
			].join("\n"),
		);
		assert.equal(checks.length, 1);
		assert.equal(checks[0]?.ok, false);
		assert.match(checks[0]?.cause ?? "", /assert 1 == 2/);
	});
});

// ─── 5. the URL law, at the seam ────────────────────────────────────────────

describe("the URL law, applied as a drop", () => {
	const PAGE: CrawledPage = {
		url: "https://example.edu/course/",
		title: "Introduction to Widgets",
		text: "A course about widgets.",
		markdown: "A course about widgets.",
		links: [],
	};

	it("keeps the course when one URL was invented", async () => {
		const draft = {
			title: "Introduction to Widgets",
			units: [
				{
					title: "Unit 1: Widgets",
					pageUrl: "https://example.edu/course/",
					problems: [
						{ title: "Lab 1", specUrl: "https://example.edu/course/labs/lab01.html" },
						{ title: "Lab 99", specUrl: "https://example.edu/course/labs/lab99.html" },
					],
				},
			],
		};
		const extraction = await extractOutline(
			[PAGE],
			["https://example.edu/course/", "https://example.edu/course/labs/lab01.html"],
			() => Promise.resolve(JSON.stringify(draft)),
		);
		assert.equal(extraction.ok, true);
		if (!extraction.ok) return;
		assert.deepEqual(extraction.dropped, ["https://example.edu/course/labs/lab99.html"]);
		assert.equal(extraction.draft.units[0]!.problems?.length, 1, "the invented problem went with its URL");
		assert.equal(extraction.draft.units[0]!.problems?.[0]?.title, "Lab 1");
	});

	it("fails only when there is nothing left to teach", async () => {
		const extraction = await extractOutline([PAGE], [], () =>
			Promise.resolve(JSON.stringify({ title: "Nothing", units: [] })),
		);
		assert.equal(extraction.ok, false);
		if (extraction.ok) return;
		assert.match(extraction.problems.join("\n"), /named no units/);
	});

	it("knows a web page from a name, with or without its scheme", () => {
		assert.equal(isWebUrl("https://cs61a.org/"), true);
		assert.equal(isWebUrl("cs61a.org"), true);
		assert.equal(isWebUrl("cs61a.org/sp/"), true);
		assert.equal(asWebUrl("cs61a.org"), "https://cs61a.org");
		assert.equal(isWebUrl("python"), false, "a name is not a URL");
		assert.equal(isWebUrl("CS50x"), false);
	});

	it("knows a course's own page from a forum thread about it", () => {
		const course = "<html><body><h1>CS61A</h1><p>Course schedule, labs and the syllabus.</p></body></html>";
		const thread = "<html><body><p>Anyone tried the new assignment yet? I got stuck on question 3.</p></body></html>";
		assert.equal(looksLikeCoursePage(course), true);
		assert.equal(looksLikeCoursePage(thread), false);
	});
});

// ─── 5b. the prompt the model is asked with ─────────────────────────────────

describe("the outline the model is asked for", () => {
	it("gives the model the LAWS, not just the pages", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("submit_outline", { title: "A course", units: [] })],
				{ stopReason: "toolUse" },
			),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const seen: Context["messages"] = [];
		const engine = {
			model: faux.getModel(),
			streamFn: (model: never, context: Context, options: never) => {
				seen.push(...context.messages);
				return models.streamSimple(model, context, options);
			},
		};
		const answer = await outlineAnswer(engine as never, "THESE ARE THE PAGES");
		// The system prompt carries the laws — without them the model answers
		// with whatever shape the pages happen to show (a schedule), and the
		// course comes out with no problems at all.
		const system = seen.find((message) => message.role === "system");
		assert.ok(system, "the model got a system prompt");
		const laws = JSON.stringify(system.content);
		assert.match(laws, /Use ONLY URLs that appear in the pages/);
		assert.match(laws, /The problems are the assignments/);
		// The pages themselves travel as the user message.
		assert.match(JSON.stringify(seen.find((message) => message.role === "user")?.content), /THESE ARE THE PAGES/);
		// The submitted outline comes back as the JSON the extractor reads.
		assert.deepEqual(JSON.parse(answer), { title: "A course", units: [] });
	});
});

// ─── 6. the reference a learner gives ───────────────────────────────────────

describe("the reference a learner gives", () => {
	it("takes the course's own page, with or without its scheme", async () => {
		const withScheme = await resolveCourseRef("https://cs61a.org/", { provider: null });
		const without = await resolveCourseRef("cs61a.org", { provider: null });
		assert.equal(without.source, "https://cs61a.org");
		assert.equal(without.ref, "https://cs61a.org", "the ref is something the registry can route");
		assert.equal(without.adapter, "generic");
		assert.equal(without.courseId, withScheme.courseId);
		assert.equal(adapterFor("cs61a.org").id, "generic");
	});

	it("finds the CS50 course a loose name points at", async () => {
		const python = await resolveCourseRef("cs50 python", { provider: null });
		assert.equal(python.courseId, "cs50p");
		assert.equal(python.adapter, "cs50");
		assert.equal(python.ref, "cs50p");
		const web = await resolveCourseRef("cs50 web programming", { provider: null });
		assert.equal(web.courseId, "cs50w");
		const flagship = await resolveCourseRef("cs50", { provider: null });
		assert.equal(flagship.courseId, "cs50x");
	});

	it("needs a REAL match — a bare language is not a course", async () => {
		// "python" names a language, not a course: it must not land on
		// CS50's Python course by accident.
		assert.equal(looseCs50Course("python"), null);
		assert.equal(looseCs50Course("c"), null);
		await assert.rejects(() => resolveCourseRef("python", { provider: null }), /Paste the course's URL/);
	});

	it("does not guess when two courses fit the name equally well", async () => {
		assert.equal(looseCs50Course("cs50 python javascript"), null);
	});

	it("checks that the search result really is a course's own page", async () => {
		const provider = {
			id: "brave" as const,
			search: () =>
				Promise.resolve([
					{ title: "A thread", url: "https://forum.example.edu/thread/123", snippet: "" },
					{ title: "CS61A", url: "https://cs61a.org/", snippet: "" },
				]),
		};
		const pages: Record<string, string> = {
			"https://forum.example.edu/thread/123": "<html><body>Anyone tried the new assignment yet?</body></html>",
			"https://cs61a.org/": "<html><body><h1>CS61A</h1><p>Course schedule, labs, syllabus.</p></body></html>",
		};
		const read = (url: string): Promise<string> =>
			pages[url] ? Promise.resolve(pages[url]!) : Promise.reject(new Error("404"));
		const page = await findCoursePage("the structure and interpretation of computer programs", { provider, fetch: read });
		assert.equal(page, "https://cs61a.org/", "the forum thread is not the course");
		const resolved = await resolveCourseRef("the structure and interpretation of computer programs", { provider, fetch: read });
		assert.equal(resolved.source, "https://cs61a.org/");
		assert.equal(resolved.ref, "https://cs61a.org/");
		assert.equal(resolved.adapter, "generic");
	});

	it("says so when no search engine can find the course", async () => {
		await assert.rejects(() => resolveCourseRef("a course nobody has heard of", { provider: null }), /Paste the course's URL/);
	});
});

// ─── 7. the starter code: the course's archive and repository ───────────────

describe("the starter archive the course hands out", () => {
	/** A course archive, served over HTTP (the app fetches it). */
	async function serveArchive(files: Record<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
		const source = fs.mkdtempSync(path.join(os.tmpdir(), "lh-archive-src-"));
		for (const [name, content] of Object.entries(files)) {
			const target = path.join(source, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content, "utf-8");
		}
		const archive = path.join(source, "..", `starter-${path.basename(source)}.tar.gz`);
		execFileSync("tar", ["-czf", archive, "-C", source, "."]);
		const server = http.createServer((req, res) => {
			if (req.url !== "/starter.tar.gz") {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-type": "application/gzip" });
			fs.createReadStream(archive).pipe(res);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		return {
			url: `http://127.0.0.1:${port}/starter.tar.gz`,
			close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		};
	}

	it("unpacks the CS50 course's archive and NEVER overwrites the learner's work", async () => {
		const archive = await serveArchive({
			"hello.py": "print('the starter')\n",
			"data/notes.txt": "the course's own notes\n",
		});
		try {
			const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cs50-prep-"));
			const problem = {
				id: "hello",
				unitId: "unit-1",
				title: "Hello",
				slug: "",
				specUrl: "https://cs50.harvard.edu/x/psets/0/hello/",
				variant: "standard" as const,
				language: "python" as const,
				distributionUrls: [archive.url],
				files: [{ name: "README.md", content: "# Hello\n", language: "text" as const }],
				estimateMinutes: 45,
			};
			const request: CourseRequest = {
				courseId: "cs50x",
				ref: "cs50x",
				source: "https://cs50.harvard.edu/x/",
				title: "CS50x",
			};
			// The first prepare: the archive is unpacked.
			const first = await cs50Adapter.prepare(request, problem, folder);
			assert.deepEqual(new Set(first.created), new Set(["README.md", "hello.py", "data/notes.txt"]));
			assert.equal(fs.readFileSync(path.join(folder, "hello.py"), "utf-8"), "print('the starter')\n");
			assert.ok(fs.existsSync(path.join(folder, "data", "notes.txt")));

			// The learner writes their own version…
			fs.writeFileSync(path.join(folder, "hello.py"), "print('mine')\n", "utf-8");
			// …and the second prepare (which happens on every view, run and
			// check) must not put the starter back.
			const second = await cs50Adapter.prepare(request, problem, folder);
			assert.deepEqual(second.created, [], "the second prepare created nothing");
			assert.equal(fs.readFileSync(path.join(folder, "hello.py"), "utf-8"), "print('mine')\n");
		} finally {
			await archive.close();
		}
	});
});

describe("the starter repository the course hands out", () => {
	it("a FAILED clone leaves the folder exactly as it was", async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-clone-"));
		fs.writeFileSync(path.join(folder, "my-work.py"), "print('mine')\n", "utf-8");
		const created = await cloneRepository("https://127.0.0.1:1/nothing.git", folder);
		assert.deepEqual(created, []);
		assert.deepEqual(fs.readdirSync(folder), ["my-work.py"], "nothing was deleted and nothing was left behind");
		assert.equal(fs.readFileSync(path.join(folder, "my-work.py"), "utf-8"), "print('mine')\n");
	});

	it("a folder that already holds the clone is left alone", async () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-clone-"));
		fs.mkdirSync(path.join(folder, ".git"));
		fs.writeFileSync(path.join(folder, "lab01.py"), "print('mine')\n", "utf-8");
		const created = await cloneRepository("https://example.edu/lab01.git", folder);
		assert.deepEqual(created, []);
		assert.ok(fs.existsSync(path.join(folder, ".git")), "the clone is still there");
		assert.equal(fs.readFileSync(path.join(folder, "lab01.py"), "utf-8"), "print('mine')\n");
	});

	it("clones into its own folder when the problem's folder already has files", async () => {
		// A course's own git server, on the machine (git http-backend speaks
		// the smart HTTP protocol git clones over).
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gitserver-"));
		const work = path.join(root, "work");
		fs.mkdirSync(work);
		const git = (args: string[], cwd: string): void => {
			execFileSync("git", args, {
				cwd,
				env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t" },
				stdio: "ignore",
			});
		};
		git(["init", "-q", work], root);
		fs.writeFileSync(path.join(work, "lab01.py"), "print('the starter')\n", "utf-8");
		git(["add", "-A"], work);
		git(["commit", "-qm", "the lab"], work);
		git(["clone", "-q", "--bare", work, path.join(root, "lab01.git")], root);

		const server = http.createServer((req, res) => {
			const backend = spawn("git", ["http-backend"], {
				env: {
					...process.env,
					GIT_PROJECT_ROOT: root,
					GIT_HTTP_EXPORT_ALL: "1",
					REQUEST_METHOD: req.method ?? "GET",
					PATH_INFO: (req.url ?? "/").split("?")[0],
					QUERY_STRING: (req.url ?? "/").split("?")[1] ?? "",
					CONTENT_TYPE: req.headers["content-type"] ?? "",
					CONTENT_LENGTH: req.headers["content-length"] ?? "",
					REMOTE_USER: "tester",
					REMOTE_ADDR: "127.0.0.1",
				},
			});
			const chunks: Buffer[] = [];
			backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			const body: Buffer[] = [];
			req.on("data", (chunk: Buffer) => body.push(chunk));
			req.on("end", () => {
				backend.stdin.end(Buffer.concat(body));
			});
			backend.on("close", () => {
				const out = Buffer.concat(chunks);
				const split = out.indexOf("\r\n\r\n");
				const head = out.subarray(0, split).toString();
				const payload = out.subarray(split + 4);
				for (const line of head.split("\r\n")) {
					const index = line.indexOf(": ");
					if (index > 0) res.setHeader(line.slice(0, index), line.slice(index + 2));
				}
				res.statusCode = 200;
				res.end(payload);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		try {
			const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lh-clone-"));
			// The problem's folder already has the spec's README: the clone
			// must land beside it, never on top of it.
			fs.writeFileSync(path.join(folder, "README.md"), "# Lab 1\n", "utf-8");
			const created = await cloneRepository(`http://127.0.0.1:${port}/lab01.git`, folder);
			assert.ok(created.includes("starter/lab01.py"), created.join(", "));
			assert.equal(fs.readFileSync(path.join(folder, "README.md"), "utf-8"), "# Lab 1\n");
			assert.ok(fs.existsSync(path.join(folder, "starter", "lab01.py")));

			// The learner works in the clone…
			fs.writeFileSync(path.join(folder, "starter", "lab01.py"), "print('mine')\n", "utf-8");
			// …and the second prepare does not clone again and does not
			// delete what the learner wrote.
			const second = await cloneRepository(`http://127.0.0.1:${port}/lab01.git`, folder);
			assert.deepEqual(second, []);
			assert.equal(fs.readFileSync(path.join(folder, "starter", "lab01.py"), "utf-8"), "print('mine')\n");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// ─── 8. the review's regressions ────────────────────────────────────────────

describe("the URL law drops EVERY invented URL", () => {
	it("drops an invented unit pageUrl (and every other URL field)", () => {
		const invented = {
			title: "Widgets",
			units: [
				{
					title: "u",
					summary: "s",
					pageUrl: "https://x.edu/invented",
					notesUrls: ["https://x.edu/notes-invented", "https://x.edu/seen"],
					videos: [{ title: "v", url: "https://x.edu/video-invented", youtubeId: "abc" }],
					problems: [
						{ title: "p", specUrl: "https://x.edu/seen", starterUrl: "https://x.edu/zip-invented", repoUrl: "https://x.edu/repo-invented" },
					],
				},
			],
		};
		const { draft, dropped } = stripInventedUrls(invented, allowedUrlSet(["https://x.edu/seen"]));
		assert.deepEqual(draft, {
			title: "Widgets",
			units: [
				{
					title: "u",
					summary: "s",
					notesUrls: ["https://x.edu/seen"],
					videos: [{ title: "v", youtubeId: "abc" }],
					problems: [{ title: "p", specUrl: "https://x.edu/seen" }],
				},
			],
		});
		assert.ok(!JSON.stringify(draft).includes("invented"), "no invented URL survives");
		assert.equal(dropped.length, 5);
	});

	it("keeps a seen unit pageUrl", () => {
		const { draft, dropped } = stripInventedUrls(
			{ title: "W", units: [{ title: "u", pageUrl: "https://x.edu/seen" }] },
			allowedUrlSet(["https://x.edu/seen"]),
		);
		assert.equal(draft.units[0]!.pageUrl, "https://x.edu/seen");
		assert.deepEqual(dropped, []);
	});
});

describe("a course number is not a URL", () => {
	it("needs an alphabetic top-level domain", () => {
		for (const name of ["6.006", "18.06", "6.S191", "node.js", "Vue.js", "main.py", "15-213"]) {
			assert.equal(isWebUrl(name), false, `${name} is not a URL`);
		}
		for (const url of ["cs61a.org", "cs61a.org/sp/", "https://x.edu/y", "http://6.006.example.edu/", "www.cs.cmu.edu/~213/"]) {
			assert.equal(isWebUrl(url), true, `${url} is a URL`);
		}
	});
});

describe("a course's own page shows a course's structure", () => {
	const COURSE = "<html><body><h1>6.006</h1><p>Syllabus. Lecture notes. Week 1: problem set 1 due. Office hours Tuesday.</p></body></html>";

	it("needs at least three distinct course signals", () => {
		assert.equal(looksLikeCoursePage(COURSE), true);
		assert.equal(looksLikeCoursePage("<p>This course is great. The course has a lecture.</p>"), false, "\"course\" alone is not a signal");
		assert.equal(looksLikeCoursePage("<p>Lectures, lectures, lecture.</p>"), false, "one signal repeated is one signal");
		assert.equal(looksLikeCoursePage("<p>The syllabus and the schedule.</p>"), false, "two signals are not enough");
	});

	it("rejects the hosts that talk ABOUT a course", () => {
		for (const url of [
			"https://en.wikipedia.org/wiki/6.006",
			"https://www.reddit.com/r/mit/comments/1",
			"https://stackoverflow.com/questions/1",
			"https://www.quora.com/What-is-6-006",
			"https://medium.com/@someone/6-006",
			"https://someone.medium.com/6-006",
		]) {
			assert.equal(looksLikeCoursePage(COURSE, url), false, url);
		}
		assert.equal(looksLikeCoursePage(COURSE, "https://ocw.mit.edu/courses/6-006/"), true);
	});

	it("reads the search hits in parallel and keeps the search's order", async () => {
		const provider = {
			id: "brave" as const,
			search: () =>
				Promise.resolve([
					{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/6.006", snippet: "" },
					{ title: "Slow course", url: "https://slow.example.edu/", snippet: "" },
					{ title: "Fast course", url: "https://fast.example.edu/", snippet: "" },
				]),
		};
		let inFlight = 0;
		let peak = 0;
		const read = async (url: string): Promise<string> => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, url.includes("slow") ? 50 : 5));
			inFlight--;
			return COURSE;
		};
		const page = await findCoursePage("6.006", { provider, fetch: read });
		assert.equal(page, "https://slow.example.edu/", "the first course page in the search's order wins");
		assert.equal(peak, 3, "the hits were read at the same time");
	});
});

describe("a generic problem that names no grader", () => {
	it("is AI-reviewed by default", async () => {
		const outline = {
			title: "Introduction to Widgets",
			units: [
				{
					title: "Unit 1: Widgets",
					problems: [{ title: "Essay", specUrl: "https://example.edu/course/syllabus.html" }],
				},
			],
		};
		const adapter = createGenericAdapter({ model: modelAnswering(outline), fetch: fakeFetch });
		const result = await adapter.outline(REQUEST);
		assert.equal(result.units[0]!.problems[0]!.grader, "ai-rubric");
	});
});
