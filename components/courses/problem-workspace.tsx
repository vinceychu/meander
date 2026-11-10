"use client";

/**
 * THE PROBLEM WORKSPACE (2026-11-09) — do the pset right here.
 *
 * An editor over the problem's files (C / C++ / Python / SQL / HTML / JS /
 * Go / Rust), a Run pane (make + the binary, python3, node, sqlite3, go,
 * rustc — server-side, sandboxed), and a Check button that runs the same
 * grader the tutor uses — the course's own grader, its tests, or the
 * tutor's review — so the two never disagree. The files live in the
 * workspace folder (~/cs50/<problem> by default) — the SAME folder VS Code
 * opens, so switching modes never loses work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection, highlightActiveLine, dropCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting, StreamLanguage, indentUnit } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { c as cLegacy } from "@codemirror/legacy-modes/mode/clike";
import { python as pythonLegacy } from "@codemirror/legacy-modes/mode/python";
import { sqlite as sqlLegacy } from "@codemirror/legacy-modes/mode/sql";
import { javascript as jsLegacy } from "@codemirror/legacy-modes/mode/javascript";
import { go as goLegacy } from "@codemirror/legacy-modes/mode/go";
import { rust as rustLegacy } from "@codemirror/legacy-modes/mode/rust";
import { html as htmlLegacy } from "@codemirror/lang-html";
import {
	BookOpenIcon,
	CheckCircle2Icon,
	Code2Icon,
	FolderOpenIcon,
	Loader2Icon,
	MessageSquareIcon,
	PlayIcon,
	SaveIcon,
	TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarToggle } from "@/components/sidebar";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";
import { graderLabel, type CourseProblem, type GraderKind } from "@/src/core";

interface ProblemFile {
	name: string;
	content: string;
	language: string;
}

interface ProblemPayload {
	problem: CourseProblem;
	unit: { id: string; title: string };
	folder: string;
	files: ProblemFile[];
	vscode: { local: string; remote: string };
}

const highlight = HighlightStyle.define([
	{ tag: t.keyword, color: "var(--lh-link)" },
	{ tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "var(--lh-ink-strong)" },
	{ tag: [t.function(t.variableName), t.labelName], color: "var(--lh-link)" },
	{ tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--lh-ink-italic)" },
	{ tag: [t.definition(t.name), t.separator], color: "var(--lh-ink-strong)" },
	{ tag: [t.className], color: "var(--lh-link)" },
	{ tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--lh-ink-italic)" },
	{ tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--lh-ink-italic)" },
	{ tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "var(--lh-link)" },
	{ tag: [t.meta, t.comment], color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: t.strong, fontWeight: "700", color: "var(--lh-ink-strong)" },
	{ tag: t.emphasis, fontStyle: "italic", color: "var(--lh-ink-italic)" },
	{ tag: t.strikethrough, textDecoration: "line-through", opacity: "0.7" },
	{ tag: t.link, textDecoration: "underline", color: "var(--lh-link)" },
	{ tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--lh-link)" },
	{ tag: [t.processingInstruction, t.string, t.inserted], color: "var(--lh-ink-strong)" },
	{ tag: t.invalid, color: "var(--destructive)" },
]);

/** The language support per file (C / C++ / Python / SQL / HTML / JS / Go / Rust). */
function languageExtension(language: string): Extension {
	if (language === "c" || language === "cpp") return StreamLanguage.define(cLegacy);
	if (language === "python") return StreamLanguage.define(pythonLegacy);
	if (language === "sql") return StreamLanguage.define(sqlLegacy);
	if (language === "html") return htmlLegacy();
	if (language === "javascript" || language === "typescript") return StreamLanguage.define(jsLegacy);
	if (language === "go") return StreamLanguage.define(goLegacy);
	if (language === "rust") return StreamLanguage.define(rustLegacy);
	return [];
}

export function ProblemWorkspace({ courseId, problemId }: { courseId: string; problemId: string }) {
	const router = useRouter();
	const [data, setData] = useState<ProblemPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [active, setActive] = useState<string | null>(null);
	const [docs, setDocs] = useState<Record<string, string>>({});
	const [dirty, setDirty] = useState<Record<string, boolean>>({});
	const [runOutput, setRunOutput] = useState<string | null>(null);
	const [checkOutput, setCheckOutput] = useState<string | null>(null);
	const [checkGrader, setCheckGrader] = useState<GraderKind | null>(null);
	const [running, setRunning] = useState(false);
	const [checking, setChecking] = useState(false);
	const [saving, setSaving] = useState(false);
	const starterRef = useMemo(() => new SessionStarter(), []);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/courses/${courseId}/problems/${problemId}`, { cache: "no-store" });
			if (!res.ok) throw new Error("The problem could not be loaded.");
			const payload = (await res.json()) as ProblemPayload;
			setData(payload);
			setDocs(Object.fromEntries(payload.files.map((f) => [f.name, f.content])));
			setDirty({});
			setActive((current) => current ?? payload.files[0]?.name ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The problem could not be loaded.");
		}
	}, [courseId, problemId]);

	useEffect(() => {
		void load();
	}, [load]);

	const save = useCallback(
		async (name: string) => {
			setSaving(true);
			try {
				const res = await fetch(`/api/courses/${courseId}/problems/${problemId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, content: docs[name] ?? "" }),
				});
				if (!res.ok) throw new Error("The file could not be saved.");
				setDirty((d) => ({ ...d, [name]: false }));
			} catch (err) {
				setError(err instanceof Error ? err.message : "The file could not be saved.");
			} finally {
				setSaving(false);
			}
		},
		[courseId, docs, problemId],
	);

	const run = useCallback(async () => {
		setRunning(true);
		setRunOutput(null);
		try {
			const res = await fetch(`/api/courses/${courseId}/problems/${problemId}`, { method: "POST" });
			const payload = (await res.json()) as { ok: boolean; output: string };
			setRunOutput(payload.output);
		} catch {
			setRunOutput("The run could not be started.");
		} finally {
			setRunning(false);
		}
	}, [courseId, problemId]);

	const check = useCallback(async () => {
		setChecking(true);
		setCheckOutput(null);
		try {
			const res = await fetch(`/api/courses/${courseId}/problems/${problemId}/check`, { method: "POST" });
			const payload = (await res.json()) as { ok: boolean; output: string; grader?: GraderKind };
			setCheckOutput(payload.output);
			setCheckGrader(payload.grader ?? null);
		} catch {
			setCheckOutput("The check could not be run.");
		} finally {
			setChecking(false);
		}
	}, [courseId, problemId]);

	if (error && !data) {
		return (
			<div className="flex h-dvh flex-col">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					<SidebarToggle />
					<h1 className="font-ui text-sm font-medium">Problem</h1>
				</header>
				<main className="px-3 py-4">
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				</main>
			</div>
		);
	}

	if (!data) {
		return (
			<div className="flex h-dvh flex-col">
				<header className="flex items-center gap-2 border-b px-3 py-2">
					<SidebarToggle />
					<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					<h1 className="font-ui text-sm font-medium">Loading the problem…</h1>
				</header>
			</div>
		);
	}

	const file = data.files.find((f) => f.name === active) ?? data.files[0] ?? null;

	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			<header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<SidebarToggle />
				<Code2Icon className="size-4 text-muted-foreground" />
				<h1 className="min-w-0 truncate font-ui text-sm font-medium">{data.problem.title}</h1>
				<span className="truncate font-ui text-xs text-muted-foreground">{data.unit.title}</span>
				<div className="ml-auto flex items-center gap-1.5">
					<Button size="sm" variant="outline" onClick={() => void run()} disabled={running}>
						{running ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
						Run
					</Button>
					<Button size="sm" onClick={() => void check()} disabled={checking} data-testid="check-problem">
						{checking ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckCircle2Icon className="size-3.5" />}
						Check
					</Button>
					<a
						href={data.vscode.local}
						className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						title={data.folder}
					>
						<FolderOpenIcon className="size-3.5" />
						Open in VS Code
					</a>
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							const target = await starterRef.start(
								{
									title: `I'm working on ${data.problem.title} — check it when I say so.`,
									courseId,
									problemId,
								},
								fetch,
							);
							router.push(target);
						}}
					>
						<MessageSquareIcon className="size-3.5" />
						Ask the tutor
					</Button>
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				{/* The files + the editor. */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-1 overflow-x-auto border-b px-2 py-1">
						{data.files.map((f) => (
							<button
								key={f.name}
								type="button"
								onClick={() => setActive(f.name)}
								className={cn(
									"shrink-0 rounded-sm px-2 py-1 font-ui text-xs transition-colors",
									f.name === active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{f.name}
								{dirty[f.name] ? " •" : ""}
							</button>
						))}
						{file && (
							<Button size="xs" variant="ghost" className="ml-auto" onClick={() => void save(file.name)} disabled={saving || !dirty[file.name]}>
								<SaveIcon className="size-3" />
								Save
							</Button>
						)}
					</div>
					<div className="min-h-0 flex-1">
						{file ? (
							<CodeEditor
								key={file.name}
								initial={docs[file.name] ?? file.content}
								language={file.language}
								onChange={(text) => {
									setDocs((d) => ({ ...d, [file.name]: text }));
									setDirty((d) => ({ ...d, [file.name]: true }));
								}}
							/>
						) : (
							<p className="px-3 py-4 text-sm text-muted-foreground">This problem has no files to edit.</p>
						)}
					</div>
				</div>

				{/* The panes: the run output and the grader's verdict. */}
				<div className="flex min-h-0 w-full flex-col border-t md:w-96 md:border-l md:border-t-0">
					<div className="flex items-center gap-2 border-b px-3 py-1.5">
						<TerminalIcon className="size-3.5 text-muted-foreground" />
						<span className="font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Output</span>
						{runOutput && (
							<span className="ml-auto font-ui text-[10px] uppercase tracking-wider text-muted-foreground">run</span>
						)}
					</div>
					<pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed">
						{runOutput ?? "Nothing run yet."}
					</pre>
					<div className="flex items-center gap-2 border-y px-3 py-1.5">
						<BookOpenIcon className="size-3.5 text-muted-foreground" />
						<span className="font-ui text-[11px] uppercase tracking-widest text-muted-foreground">Check</span>
						{checkOutput && (
							<span className="ml-auto font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
								{graderLabel({ grader: checkGrader ?? data.problem.grader })}
							</span>
						)}
					</div>
					<pre className="max-h-64 min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed">
						{checkOutput ?? "Not checked yet — press Check."}
					</pre>
					<div className="border-t px-3 py-2">
						<p className="font-ui text-[10px] leading-relaxed text-muted-foreground">
							The files live in <span className="font-mono">{data.folder}</span> — the same folder VS Code opens. Nothing is
							submitted to the course for you.
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

/** The editor: CodeMirror 6 with the language support for the file. */
function CodeEditor({
	initial,
	language,
	onChange,
}: {
	initial: string;
	language: string;
	onChange: (text: string) => void;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		const extensions: Extension[] = [
			history(),
			drawSelection(),
			dropCursor(),
			highlightActiveLine(),
			EditorView.lineWrapping,
			indentUnit.of("\t"),
			EditorState.tabSize.of(4),
			syntaxHighlighting(highlight),
			languageExtension(language),
			placeholder("Write your solution here…"),
			EditorView.contentAttributes.of({ spellcheck: "false", autocapitalize: "off" }),
			keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged) onChangeRef.current(u.state.doc.toString());
			}),
		];
		const view = new EditorView({
			state: EditorState.create({ doc: initial, extensions }),
			parent: parent.current!,
		});
		return () => view.destroy();
	}, [initial, language]);

	return <div ref={parent} className="h-full min-h-64 overflow-auto" data-testid="problem-editor" />;
}
