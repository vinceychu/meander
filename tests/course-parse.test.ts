/**
 * COURSE PARSING (2026-11-09): the readers that turn a course's own pages
 * into a syllabus.
 *
 * The fixtures under tests/fixtures/ are trimmed copies of the real CS50
 * pages (fetched 2026-11-09): the weeks index, a week page, a problem-set
 * page and one problem spec. The trim cut prose, never structure — the
 * shape of the page is what the parsers read.
 *
 * The laws pinned here:
 * - the syllabus comes from the INDEX page (CS50 hides a bonus unit in it,
 *   so "weeks 0..10" is a lie);
 * - a problem's variant comes from its path, and the check50 slug is read
 *   off the spec, never guessed;
 * - a distribution archive is only ever a .zip the page actually names;
 * - a video's timestamp comes from the page's own embed, never invented.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	condenseNotes,
	extractCheckSlug,
	extractDistributionUrls,
	extractFileName,
	extractFolderName,
	formatTimestamp,
	htmlToMarkdown,
	htmlToText,
	parseProblemSetPage,
	parseSpecPage,
	parseSrtTimeline,
	parseTimestamp,
	parseUnitIndex,
	parseUnitPage,
} from "../src/core/course-parse.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");

const INDEX_URL = "https://cs50.harvard.edu/x/weeks/";
const WEEK_URL = "https://cs50.harvard.edu/x/weeks/1/";
const PSET_URL = "https://cs50.harvard.edu/x/psets/1/";
const MARIO_URL = "https://cs50.harvard.edu/x/psets/1/mario/less/";

describe("the unit index (the syllabus)", () => {
	it("reads every unit the page lists — including the one week 7 hides", () => {
		const units = parseUnitIndex(read("cs50-weeks-index.html"), INDEX_URL);
		const titles = units.map((u) => u.title);
		assert.ok(titles.includes("Week 0"));
		assert.ok(titles.includes("Week 1"));
		assert.ok(titles.includes("Week 10"));
		// The bonus unit sits between weeks 7 and 8: an index that stops at
		// "week 10" would miss it.
		assert.ok(titles.includes("Artificial Intelligence"), "the AI unit is in the index");
		const ai = units.find((u) => u.title === "Artificial Intelligence");
		assert.equal(ai?.url, "https://cs50.harvard.edu/x/weeks/ai/");
	});

	it("keeps the page's order", () => {
		const units = parseUnitIndex(read("cs50-weeks-index.html"), INDEX_URL);
		assert.equal(units[0]?.url, "https://cs50.harvard.edu/x/weeks/0/");
		assert.equal(units[1]?.url, "https://cs50.harvard.edu/x/weeks/1/");
		const aiIndex = units.findIndex((u) => u.title === "Artificial Intelligence");
		const week8Index = units.findIndex((u) => u.title === "Week 8");
		assert.ok(aiIndex >= 0 && week8Index > aiIndex, "the AI unit comes before week 8");
	});

	it("resolves a relative unit link against the page it was on", () => {
		const units = parseUnitIndex(read("cs50-weeks-index.html"), INDEX_URL);
		for (const unit of units) assert.match(unit.url, /^https:\/\/cs50\.harvard\.edu\/x\/weeks\//);
	});
});

describe("a unit page", () => {
	it("reads the title, the summary and the lecture", () => {
		const page = parseUnitPage(read("cs50-week1.html"), WEEK_URL);
		assert.equal(page.title, "Week 1 C");
		assert.match(page.summary, /Source Code/);
		assert.equal(page.videoId, "SlqjA04_dpk");
	});

	it("finds the notes and the problem set", () => {
		const page = parseUnitPage(read("cs50-week1.html"), WEEK_URL);
		assert.equal(page.notesUrl, "https://cs50.harvard.edu/x/notes/1/");
		assert.equal(page.psetUrl, "https://cs50.harvard.edu/x/psets/1/");
	});

	it("prefers the English subtitle track", () => {
		const page = parseUnitPage(read("cs50-week1.html"), WEEK_URL);
		assert.match(page.subtitlesUrl ?? "", /\/lang\/en\/lecture1\.srt$/);
		assert.match(page.transcriptUrl ?? "", /\/lang\/en\/lecture1\.txt$/);
	});
});

describe("a problem-set page", () => {
	const problems = parseProblemSetPage(read("cs50-pset1.html"), PSET_URL);

	it("reads every problem it lists", () => {
		const titles = problems.map((p) => p.title);
		assert.ok(titles.includes("Hello, World"));
		assert.ok(titles.includes("Mario"));
		assert.ok(titles.includes("Cash"));
		assert.equal(problems.length, 6);
	});

	it("reads the variant off the path (less / more / one)", () => {
		const mario = problems.find((p) => p.specUrl.endsWith("/mario/less/"));
		const marioMore = problems.find((p) => p.specUrl.endsWith("/mario/more/"));
		const world = problems.find((p) => p.specUrl.endsWith("/world/"));
		assert.equal(mario?.variant, "less");
		assert.equal(marioMore?.variant, "more");
		assert.equal(world?.variant, "standard");
	});

	it("resolves the spec URLs against the problem-set page", () => {
		const mario = problems.find((p) => p.specUrl.endsWith("/mario/less/"));
		assert.equal(mario?.specUrl, "https://cs50.harvard.edu/x/psets/1/mario/less/");
	});

	it("drops the page's chrome links (absolute, outside the content column)", () => {
		for (const problem of problems) {
			assert.match(problem.specUrl, /^https:\/\/cs50\.harvard\.edu\/x\/psets\/1\//);
		}
	});
});

describe("a problem spec", () => {
	const spec = parseSpecPage(read("cs50-mario-less.html"), MARIO_URL);

	it("reads the check50 slug the page states", () => {
		assert.equal(spec.slug, "cs50/problems/2026/x/mario/less");
	});

	it("reads the file and the folder the learner works in", () => {
		assert.equal(spec.fileName, "mario.c");
		assert.equal(spec.folderName, "mario-less");
	});

	it("is a C problem", () => {
		assert.equal(spec.language, "c");
	});

	it("reads the page's own videos with their real start times", () => {
		assert.equal(spec.videoEmbeds.length, 2);
		const demo = spec.videoEmbeds.find((v) => v.youtubeId === "cWOkHQXw0JQ");
		assert.equal(demo?.startSeconds, 11, "the demo's own chapter mark");
		const walkthrough = spec.videoEmbeds.find((v) => v.youtubeId === "NAs4FIWkJ4s");
		assert.equal(walkthrough?.startSeconds, undefined, "no mark means no timestamp");
	});

	it("keeps the task text and the starter code", () => {
		assert.match(spec.taskMarkdown, /mario\.c/);
		assert.match(spec.starterCode ?? "", /#include/);
	});

	it("states that no distribution archive is handed out", () => {
		// The 2026 CS50 psets ship no zip: the plan must not invent one.
		assert.deepEqual(spec.distributionUrls, []);
	});
});

describe("distribution archives", () => {
	it("reads the wget line of a lecture page", () => {
		const urls = extractDistributionUrls("wget https://cdn.cs50.net/2025/fall/lectures/1/src1.zip");
		assert.deepEqual(urls, ["https://cdn.cs50.net/2025/fall/lectures/1/src1.zip"]);
	});

	it("reads a bare zip link", () => {
		const urls = extractDistributionUrls('see <a href="https://cdn.cs50.net/2025/fall/lectures/1/src1.zip">Zip</a>');
		assert.deepEqual(urls, ["https://cdn.cs50.net/2025/fall/lectures/1/src1.zip"]);
	});

	it("never invents one: a page without a zip yields nothing", () => {
		assert.deepEqual(extractDistributionUrls("In a file called mario.c, implement the program."), []);
	});

	it("ignores anything that is not a zip", () => {
		assert.deepEqual(extractDistributionUrls("wget https://cdn.cs50.net/2025/fall/lectures/1/lecture1.pdf"), []);
	});

	it("finds the lecture's zip in the week page", () => {
		const text = htmlToText(read("cs50-week1.html"));
		assert.ok(extractDistributionUrls(text).includes("https://cdn.cs50.net/2025/fall/lectures/1/src1.zip"));
	});
});

describe("the spec's small facts", () => {
	it("reads the check slug out of the correctness section", () => {
		assert.equal(extractCheckSlug("check50 cs50/problems/2026/x/mario/less"), "cs50/problems/2026/x/mario/less");
		assert.equal(extractCheckSlug("no slug here"), null);
	});

	it("reads the file name", () => {
		assert.equal(extractFileName("In a file called mario.c in a folder called mario-less"), "mario.c");
		assert.equal(extractFileName("nothing"), null);
	});

	it("reads the folder name", () => {
		assert.equal(extractFolderName("In a file called mario.c in a folder called mario-less"), "mario-less");
	});
});

describe("the subtitle timeline (where a video segment's timestamp may come from)", () => {
	const srt = [
		"1",
		"00:00:00,000 --> 00:00:04,000",
		"Hello and welcome to week one.",
		"",
		"2",
		"00:00:04,000 --> 00:00:09,000",
		"Today we talk about C.",
		"",
		"3",
		"00:01:00,000 --> 00:01:05,000",
		"Back to the compiler.",
		"",
	].join("\n");

	it("samples the track into real timestamps", () => {
		const timeline = parseSrtTimeline(srt, { stepSeconds: 30, maxEntries: 10 });
		assert.equal(timeline[0]?.seconds, 0);
		assert.ok(timeline.some((entry) => entry.seconds === 60), "the one-minute mark is there");
		assert.match(timeline[0]?.text ?? "", /Hello and welcome/);
	});

	it("returns nothing for a track it cannot read", () => {
		assert.deepEqual(parseSrtTimeline("not a subtitle file"), []);
	});
});

describe("timestamps", () => {
	it("round-trips", () => {
		assert.equal(parseTimestamp("1:23:45"), 5025);
		assert.equal(parseTimestamp("23:45"), 1425);
		assert.equal(formatTimestamp(5025), "1:23:45");
		assert.equal(formatTimestamp(75), "1:15");
		assert.equal(parseTimestamp("nope"), null);
	});
});

describe("the condensed lesson (the notes' own digest)", () => {
	const markdown = htmlToMarkdown(read("cs50-week1.html"));

	it("keeps the notes' headings and drops the noise", () => {
		const lesson = condenseNotes(markdown, { maxChars: 2000 });
		assert.ok(lesson.length > 0);
		assert.ok(lesson.length <= 2000);
		assert.match(lesson, /#/);
	});

	it("is a digest, not the whole page", () => {
		const lesson = condenseNotes(markdown, { maxChars: 2000 });
		assert.ok(lesson.length < markdown.length);
	});
});
