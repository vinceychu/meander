/**
 * THE COURSE ADAPTERS (2026-11-09) — "learn ANY course".
 *
 * Three laws are pinned here, and they are the point of the seam:
 *
 *   1. DETECTION — a reference names one adapter: the CS50 family for the
 *      CS50 courses (by id, by title, by their own URL), the generic
 *      adapter for every other course page.
 *   2. THE URL LAW — every URL in an extracted outline must be one the
 *      crawl SAW. A model that invents "https://example.edu/labs/lab99.html"
 *      is rejected, and the rejection names the URL.
 *   3. THE GRADER — a course's own grader is preferred over anything else
 *      (`ok` first, then the test suite), and a course that ships none says
 *      so instead of faking a check.
 *
 * The CS50 fixtures are trimmed copies of the real pages (fetched
 * 2026-11-09); the generic course is a hand-written fake site (see
 * tests/fixtures/generic-course/), so nothing here touches the network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseProblemSetPage, parseSpecPage, parseUnitIndex, parseUnitPage } from "../src/core/course-parse.ts";
import { detectGrader, checksToLines, parseTestOutput, summaryLine } from "../src/core/course-graders.ts";
import { graderLabel, graderOf } from "../src/core/course-adapters.ts";
import type { CourseRequest } from "../src/core/courses.ts";
import { adapterFor, resolveCourseRef } from "../src/server/course-adapters/index.ts";
import { cs50Adapter, cs50CourseFor, problemIdFromPath } from "../src/server/course-adapters/cs50.ts";
import { createGenericAdapter, courseIdForUrl, genericAdapter } from "../src/server/course-adapters/generic.ts";

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

	it("REJECTS an invented URL — the model cannot make one up", async () => {
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
		await assert.rejects(
			() => adapter.outline(REQUEST),
			/lab99\.html[\s\S]*invented URLs are rejected/,
		);
	});

	it("REJECTS an invented notes URL too", async () => {
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
		await assert.rejects(() => adapter.outline(REQUEST), /invented URLs are rejected/);
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
