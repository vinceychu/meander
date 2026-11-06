import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as N from "../src/core/notes.ts";

const f = (path: string) => ({ path, size: 1, mtime: 1, ctime: 1 });

describe("notes: frontmatter", () => {
	it("parses scalars, lists and flow lists", () => {
		const fm = N.parseFrontmatter("---\ntitle: Hello: world\ntags:\n  - a\n  - b\nn: 3\nok: true\nal: [x, \"y z\"]\n---\nBody");
		assert.equal(fm.body, "Body");
		assert.deepEqual(fm.props.tags, ["a", "b"]);
		assert.equal(fm.props.n, 3);
		assert.equal(fm.props.ok, true);
		assert.deepEqual(fm.props.al, ["x", "y z"]);
		assert.equal(fm.props.title, "Hello: world");
	});
	it("round-trips props", () => {
		const text = N.withProps("hello", { status: "todo", tags: ["x"], due: "2026-11-06" });
		const fm = N.parseFrontmatter(text);
		assert.deepEqual(fm.props, { status: "todo", tags: ["x"], due: "2026-11-06" });
		assert.equal(fm.body, "hello");
		assert.equal(N.withProps(text, {}), "hello");
	});
});

describe("notes: links and tags", () => {
	it("extracts wikilinks with headings, blocks, aliases, embeds; ignores code", () => {
		const ls = N.extractWikiLinks("a [[Note#Sec|Alias]] ![[img.png|300]] `[[no]]` [[#Local]] [[B#^blk]]");
		assert.deepEqual(ls.map((l) => [l.target, l.heading, l.block, l.alias, l.embed]), [
			["Note", "Sec", undefined, "Alias", false],
			["img.png", undefined, undefined, "300", true],
			["", "Local", undefined, undefined, false],
			["B", undefined, "blk", undefined, false],
		]);
	});
	it("finds tags but not headings, urls or code", () => {
		assert.deepEqual(N.extractInlineTags("# Head\n#one and #two/sub [x](a#frag) `#code` #3 #a1"), ["one", "two/sub", "a1"]);
	});
	it("resolves links Obsidian-style", () => {
		const r = new N.LinkResolver([f("a/Note.md"), f("b/c/Note.md"), f("Other.md"), f("img/pic.png")], [{ path: "Other.md", aliases: ["Alt"] }]);
		assert.equal(r.resolve("Note"), "a/Note.md");
		assert.equal(r.resolve("b/c/Note"), "b/c/Note.md");
		assert.equal(r.resolve("c/Note"), "b/c/Note.md");
		assert.equal(r.resolve("pic.png"), "img/pic.png");
		assert.equal(r.resolve("Alt"), "Other.md");
		assert.equal(r.resolve("Missing"), null);
		assert.equal(r.linkText("b/c/Note.md"), "b/c/Note");
		assert.equal(r.linkText("Other.md"), "Other");
	});
});

describe("notes: index, rename, search", () => {
	const texts: Record<string, string> = {
		"A.md": "---\ntags: [proj]\nstatus: doing\n---\nSee [[B]] and [[Ghost]]. #idea\n- [ ] task\n- [x] done",
		"B.md": "# B\nBack to [[A|the a]]. Mentions A plainly.",
		"sub/C.md": "Talks about B without a link.",
	};
	const files = Object.keys(texts).map(f);
	const idx = N.buildIndex(files, (p) => texts[p] ?? null);
	it("builds backlinks, tags, unresolved", () => {
		assert.deepEqual(idx.backlinks["B.md"], ["A.md"]);
		assert.deepEqual(idx.backlinks["A.md"], ["B.md"]);
		assert.deepEqual(idx.unresolved.Ghost, ["A.md"]);
		assert.equal(idx.tags.proj!.count, 1);
		assert.equal(idx.tags.idea!.count, 1);
		const a = idx.notes.find((n) => n.path === "A.md")!;
		assert.deepEqual(a.tasks, { total: 2, done: 1 });
	});
	it("rewrites links on rename, keeping aliases", () => {
		const before = new N.LinkResolver(files);
		const after = new N.LinkResolver(files.map((x) => (x.path === "A.md" ? f("archive/Alpha.md") : x)));
		assert.equal(N.rewriteLinks(texts["B.md"]!, "B.md", "A.md", "archive/Alpha.md", before, after), "# B\nBack to [[Alpha|the a]]. Mentions A plainly.");
	});
	it("finds unlinked mentions", () => {
		const m = N.unlinkedMentions("B", [], Object.entries(texts).map(([path, text]) => ({ path, text })), "B.md");
		// Too short (<3 chars) → none; a longer title works.
		assert.equal(m.length, 0);
		const m2 = N.unlinkedMentions("Talks", [], [{ path: "x.md", text: "talks here" }], "y.md");
		assert.equal(m2.length, 1);
	});
	it("searches with operators", () => {
		const notes = idx.notes.map((meta) => ({ meta, text: texts[meta.path]! }));
		assert.deepEqual(N.searchNotes("tag:#proj", notes).map((h) => h.path), ["A.md"]);
		assert.deepEqual(N.searchNotes("path:sub", notes).map((h) => h.path), ["sub/C.md"]);
		assert.deepEqual(N.searchNotes("\"without a link\"", notes).map((h) => h.path), ["sub/C.md"]);
		assert.deepEqual(N.searchNotes("[status:doing]", notes).map((h) => h.path), ["A.md"]);
		assert.deepEqual(N.searchNotes("task-todo:", notes).map((h) => h.path), ["A.md"]);
		assert.ok(!N.searchNotes("mentions -plainly", notes).length);
	});
	it("runs base views: filter, sort, group, kanban order, formulas", () => {
		const cfg: N.BaseConfig = { filters: [], formulas: { twice: "file.words * 2" }, views: [] };
		const view: N.BaseView = { name: "k", type: "kanban", columns: ["file.name", "formula.twice"], filters: [{ prop: "file.folder", op: "is", value: "" }], groupBy: "status", groupOrder: ["todo", "doing", "done"] };
		const r = N.runBaseView(cfg, view, idx.notes, { backlinks: idx.backlinks });
		assert.deepEqual(r.groups!.map((g) => [g.key, g.notes.map((n) => n.title)]), [["todo", []], ["doing", ["A"]], ["done", []], ["", ["B"]]]);
		const a = idx.notes.find((n) => n.path === "A.md")!;
		assert.equal(N.propValue(a, "formula.twice", { backlinks: {}, formulas: cfg.formulas }), a.words * 2);
		assert.equal(N.evalFormula("if(status == \"doing\", \"yes\", \"no\")", a), "yes");
		assert.equal(N.evalFormula("1 +", a), "⚠");
	});
});

describe("notes: reading view", () => {
	it("turns Obsidian syntax into renderable markdown", () => {
		const out = N.preprocessForReading("---\na: 1\n---\n[[Note|N]] ![[pic.png|200]] ==hi== =={red}r== %%secret%% #tag `[[code]]` x ^blk", {
			resolve: (t) => (t === "Note" ? "Note.md" : t === "pic.png" ? "pic.png" : null),
		});
		assert.match(out, /\[N\]\(\/notes\?open=Note\.md\)/);
		assert.match(out, /!\[pic\|200\]\(\/api\/notes\/raw\?path=pic\.png\)/);
		assert.match(out, /\[hi\]\(#lh-mark\)/);
		assert.match(out, /\[r\]\(#lh-mark-red\)/);
		assert.doesNotMatch(out, /secret/);
		assert.match(out, /\[#tag\]\(\/notes\?tag=tag\)/);
		assert.match(out, /`\[\[code\]\]`/);
		assert.doesNotMatch(out, /\^blk/);
	});
	it("cleans paths", () => {
		assert.equal(N.cleanNotePath("a/../b"), null);
		assert.equal(N.cleanNotePath(".obsidian/x"), null);
		assert.equal(N.cleanNotePath("/a//b.md"), "a/b.md");
	});
	it("fills templates", () => {
		assert.equal(N.fillTemplate("# {{title}} {{date:YYYY}}", "T", new Date(2026, 0, 2)), "# T 2026");
	});
});

describe("notes: reading view links", () => {
	it("keeps same-note heading links as links, not tags", () => {
		const out = N.preprocessForReading("[[#Intro]] and #real", { resolve: () => null });
		assert.match(out, /\[Intro\]\(#Intro\)/);
		assert.match(out, /\[#real\]\(\/notes\?tag=real\)/);
	});
});
