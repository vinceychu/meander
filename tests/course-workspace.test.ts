/**
 * THE COURSE WORKSPACE (2026-11-10) — the folder the learner works in.
 *
 * The app PREPARES a problem on every view, every save, every run and
 * every check. So a prepare that overwrote a file — or a clone that failed
 * and took the folder with it — would wipe the learner's solution right
 * before it is graded. The flow pinned here is the one the learner actually
 * does:
 *
 *     GET → edit → GET → Run → Check
 *
 * and the edit must be there at the end.
 *
 * The other half of the law is the FOLDER: a course that hands its lab out
 * in a subfolder ("lab01/") keeps its code there, so the editor reads and
 * writes the nested name ("lab01/lab01.py"), the Run pane runs it where it
 * lives, the grader runs where it lives — and a name that tries to climb
 * out of the folder is refused.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// ─── the test's own app ─────────────────────────────────────────────────────
// The data dir (where the courses live) and the workspace root (where the
// learner's folders live) are read from the environment BEFORE anything
// else is imported, so they are set here, first thing.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-data-"));
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-root-"));
process.env.LH_DATA_DIR = DATA_DIR;
fs.writeFileSync(
	path.join(DATA_DIR, "settings.json"),
	JSON.stringify({ courses: { workspaceRoot: WORKSPACE } }),
	"utf-8",
);

/**
 * A fake bubblewrap.
 *
 * Bubblewrap cannot create namespaces on every box (this one included), so
 * the test puts a `bwrap` on the PATH that RECORDS the confinement it was
 * asked for and then runs the command the way the real one would — same
 * working directory, same arguments. The RECORD is what the test asserts;
 * the command still runs for real, so the flow is the app's own.
 */
const FAKE_BWRAP = `#!/bin/sh
log="$LH_FAKE_SANDBOX_LOG"
if [ -n "$log" ]; then
	printf '%s\\n' "$@" >> "$log"
	printf '%s\\n' '---' >> "$log"
fi
chdir=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--chdir) chdir="$2"; shift 2;;
		--ro-bind|--bind) shift 3;;
		--dev|--proc|--tmpfs) shift 2;;
		--unshare-all|--die-with-parent|--new-session) shift;;
		--) shift; break;;
		*) break;;
	esac
done
if [ -n "$chdir" ]; then cd "$chdir" || exit 127; fi
exec "$@"
`;

const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-bin-"));
const SANDBOX_LOG = path.join(FAKE_BIN, "sandbox.log");
fs.writeFileSync(path.join(FAKE_BIN, "bwrap"), FAKE_BWRAP, { mode: 0o755 });
process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.LH_FAKE_SANDBOX_LOG = SANDBOX_LOG;

/** The confinement the last sandboxed run was asked for (one argv per run). */
function sandboxRuns(): string[][] {
	try {
		const raw = fs.readFileSync(SANDBOX_LOG, "utf-8");
		return raw
			.split("---\n")
			.map((block) => block.split("\n").filter(Boolean))
			.filter((block) => block.length > 0);
	} catch {
		return [];
	}
}

// The app itself — imported AFTER the environment is set.
const { writeCourse, writeCourseRequest } = await import("../src/store/courses.ts");
const problemRoute = await import("../app/api/courses/[courseId]/problems/[problemId]/route.ts");
const checkRoute = await import("../app/api/courses/[courseId]/problems/[problemId]/check/route.ts");

const COURSE_ID = "widgets";
const PROBLEM_ID = "widgets-lab01";
const FOLDER = path.join(WORKSPACE, PROBLEM_ID);
const NESTED = "lab01/lab01.py";

/** The course's own test file: it reads the learner's code and grades it. */
const COURSE_TEST = `import importlib.util
import pathlib

here = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("lab01", here / "lab01.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.pick_digit() == 7, "pick_digit() must return 7"
print("tests/test_lab01.py::test_pick_digit PASSED")
`;

/** The learner work as the course hands it out (the starter). */
const STARTER = `def pick_digit():
    return 0


print("picked", pick_digit())
`;

/** The learner's edit — the file the rest of the flow must not lose. */
const EDITED = `def pick_digit():
    return 7


print("picked", pick_digit())
`;

/** The course on disk: one unit, one problem, its lab in a subfolder. */
const COURSE = {
	id: COURSE_ID,
	title: "Introduction to Widgets",
	source: "https://example.edu/course/",
	createdAt: "2026-11-10T00:00:00.000Z",
	updatedAt: "2026-11-10T00:00:00.000Z",
	settings: { defaultMode: "app" as const, videos: false },
	units: [
		{
			id: "unit-1",
			index: 0,
			title: "Unit 1: Widgets",
			summary: "How widgets are made.",
			notesUrl: "",
			lesson: "",
			videos: [],
			estimateMinutes: 60,
			problems: [
				{
					id: PROBLEM_ID,
					unitId: "unit-1",
					title: "Lab 1: Widgets",
					slug: "",
					specUrl: "https://example.edu/course/labs/lab01.html",
					variant: "standard" as const,
					language: "python" as const,
					distributionUrls: [],
					files: [
						{ name: NESTED, content: STARTER, language: "python" as const },
						{ name: "lab01/run-tests.py", content: COURSE_TEST, language: "python" as const },
						{ name: "README.md", content: "# Lab 1: Widgets\n\nMake a widget.\n", language: "text" as const },
					],
					estimateMinutes: 45,
					grader: "tests" as const,
					graderCommand: "python3 run-tests.py",
					graderWorkDir: "lab01",
				},
			],
		},
	],
};

/** The course's request record (what the learner asked for). */
const REQUEST = {
	courseId: COURSE_ID,
	ref: "https://example.edu/course/",
	title: "Introduction to Widgets",
	source: "https://example.edu/course/",
	adapter: "generic",
};

writeCourse(COURSE);
writeCourseRequest(COURSE_ID, REQUEST);

/** The route's params (Next hands them over as a promise). */
const params = { params: Promise.resolve({ courseId: COURSE_ID, problemId: PROBLEM_ID }) };

/** GET the problem. */
function getProblem(): Promise<Response> {
	return problemRoute.GET(new Request("http://localhost/api"), params);
}

/** PUT one file (the editor's save). */
function putFile(name: string, content: string): Promise<Response> {
	return problemRoute.PUT(
		new Request("http://localhost/api", {
			method: "PUT",
			body: JSON.stringify({ name, content }),
			headers: { "content-type": "application/json" },
		}),
		params,
	);
}

// ─── the law: a prepare never touches the learner's work ────────────────────

describe("the course workspace keeps the learner's work", () => {
	it("survives GET → edit → GET → Run → Check", async () => {
		// 1. GET — the problem is prepared for the first time.
		const first = await getProblem();
		assert.equal(first.status, 200);
		const firstBody = (await first.json()) as { files: Array<{ name: string; content: string }>; folder: string };
		assert.equal(firstBody.folder, FOLDER);
		assert.ok(
			firstBody.files.some((file) => file.name === NESTED),
			"the lab's file is in the editor, with its folder",
		);
		assert.equal(fs.readFileSync(path.join(FOLDER, NESTED), "utf-8"), STARTER);

		// 2. Edit — the learner changes the nested file.
		const saved = await putFile(NESTED, EDITED);
		assert.equal(saved.status, 200);
		assert.equal(fs.readFileSync(path.join(FOLDER, NESTED), "utf-8"), EDITED);

		// 3. GET again — a prepare runs on every view. The edit must be there.
		const second = await getProblem();
		assert.equal(second.status, 200);
		const secondBody = (await second.json()) as { files: Array<{ name: string; content: string }> };
		const nested = secondBody.files.find((file) => file.name === NESTED);
		assert.equal(nested?.content, EDITED, "the second prepare did not overwrite the learner's edit");

		// 4. Run — the program runs where it lives (in the lab's folder).
		const run = await problemRoute.POST(new Request("http://localhost/api", { method: "POST" }), params);
		assert.equal(run.status, 200);
		const runBody = (await run.json()) as { ok: boolean; output: string };
		assert.equal(runBody.ok, true, runBody.output);
		assert.match(runBody.output, /picked 7/, "the learner code ran, with the learner's edit");

		// 5. Check — the grader reads the learner's file and passes it.
		const check = await checkRoute.POST(new Request("http://localhost/api", { method: "POST" }), params);
		assert.equal(check.status, 200);
		const checkBody = (await check.json()) as { ok: boolean; output: string; grader: string };
		assert.equal(checkBody.grader, "tests");
		assert.equal(checkBody.ok, true, checkBody.output);
		assert.match(checkBody.output, /test_pick_digit/);

		// …and the edit is still there after the check.
		assert.equal(fs.readFileSync(path.join(FOLDER, NESTED), "utf-8"), EDITED);
	});

	it("keeps the edit when the course's own files are re-prepared", async () => {
		// The learner changed the course's test file too: the next prepare
		// must not put the starter back.
		const mine = "print('my own runner')\n";
		assert.equal((await putFile("lab01/run-tests.py", mine)).status, 200);
		await getProblem();
		assert.equal(fs.readFileSync(path.join(FOLDER, "lab01", "run-tests.py"), "utf-8"), mine);
	});

	it("runs the grader inside the same sandbox the app's Check uses", async () => {
		fs.writeFileSync(SANDBOX_LOG, "", "utf-8");
		await checkRoute.POST(new Request("http://localhost/api", { method: "POST" }), params);
		const runs = sandboxRuns();
		assert.ok(runs.length > 0, "the grader ran through the sandbox");
		const argv = runs[runs.length - 1]!;
		assert.equal(argv[0], "--ro-bind");
		assert.ok(argv.includes("--unshare-all"), "the code ran with no namespaces");
		assert.ok(argv.includes("--die-with-parent"));
		assert.ok(argv.includes("--new-session"));
		// The problem's own folder is the only writable place.
		const bind = argv.indexOf("--bind");
		assert.ok(bind >= 0, "the problem's folder is bound writable");
		assert.equal(argv[bind + 1], FOLDER);
		assert.equal(argv[bind + 2], FOLDER);
		// The grader runs where the course's code lives.
		const chdir = argv[argv.indexOf("--chdir") + 1];
		assert.equal(chdir, path.join(FOLDER, "lab01"));
		// …and the command itself is the course's own.
		assert.ok(argv.includes("python3"));
		assert.ok(argv.includes("run-tests.py"));
	});
});

// ─── the law: the folder is the one workspace ───────────────────────────────

describe("the editor reaches the course's subfolder", () => {
	it("saves a file in a folder that does not exist yet", async () => {
		const saved = await putFile("lab01/notes/today.md", "# Today\n");
		assert.equal(saved.status, 200);
		assert.equal(fs.readFileSync(path.join(FOLDER, "lab01", "notes", "today.md"), "utf-8"), "# Today\n");
	});

	it("refuses a name that climbs out of the problem's folder", async () => {
		const escape = path.join(WORKSPACE, "escaped.txt");
		const response = await putFile("../escaped.txt", "gotcha");
		assert.equal(response.status, 400);
		assert.ok(!fs.existsSync(escape), "nothing was written outside the folder");
	});

	it("refuses an absolute path", async () => {
		const response = await putFile("/tmp/lh-escaped.txt", "gotcha");
		assert.equal(response.status, 400);
		assert.ok(!fs.existsSync("/tmp/lh-escaped.txt"));
	});

	it("refuses a name that climbs out through a folder", async () => {
		const response = await putFile("lab01/../../escaped.txt", "gotcha");
		assert.equal(response.status, 400);
		assert.ok(!fs.existsSync(path.join(WORKSPACE, "escaped.txt")));
	});

	it("refuses a hidden folder (the course's own tooling, not the learner's)", async () => {
		const response = await putFile(".ssh/authorized_keys", "gotcha");
		assert.equal(response.status, 400);
	});
});
