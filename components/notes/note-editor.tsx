"use client";
/**
 * The notes editor (2026-11-06): CodeMirror 6 over the raw Markdown, with
 * Live Preview (live-preview.ts) or plain Source mode. Obsidian behaviors:
 * [[ autocompletes notes (then # headings, | alias), # autocompletes tags,
 * clicking a rendered link opens it (Mod-click in source), pasting a URL
 * over a selection makes a link (1.11), pasted/dropped files become
 * attachments embedded with ![[…]], Mod-B/I/K/E-style formatting keys,
 * Mod-Enter toggles a checkbox, Alt-↑/↓ moves lines.
 */
import { useEffect, useRef } from "react";
import { EditorState, Compartment, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection, highlightActiveLine, dropCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineDown, moveLineUp } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { autocompletion, closeBrackets, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { livePreview, refreshLivePreview } from "./live-preview";
import { Notes, localDate } from "@/src/core";

export interface EditorHost {
	resolve: (target: string) => string | null;
	rawHref: (path: string) => string;
	isImage: (path: string) => boolean;
	/** [[ completions: note titles/paths (+ aliases). */
	noteOptions: () => { label: string; detail?: string; path: string }[];
	headingsOf: (path: string) => string[];
	tagOptions: () => { tag: string; count: number }[];
	openLink: (target: string, newTab: boolean) => void;
	openTag: (tag: string) => void;
	upload: (files: File[]) => Promise<string[]>;
	linkText: (path: string) => string;
}

export interface NoteEditorHandle {
	view: EditorView | null;
}

const highlight = HighlightStyle.define([
	{ tag: t.heading1, class: "cm-md-h1" },
	{ tag: t.heading2, class: "cm-md-h2" },
	{ tag: t.heading3, class: "cm-md-h3" },
	{ tag: [t.heading4, t.heading5, t.heading6], class: "cm-md-h4" },
	{ tag: t.strong, fontWeight: "700", color: "var(--lh-ink-strong)" },
	{ tag: t.emphasis, fontStyle: "italic", color: "var(--lh-ink-italic)" },
	{ tag: t.strikethrough, textDecoration: "line-through", opacity: "0.7" },
	{ tag: t.monospace, class: "cm-md-code" },
	{ tag: t.link, color: "var(--lh-link)" },
	{ tag: t.url, color: "var(--muted-foreground)" },
	{ tag: t.quote, color: "var(--muted-foreground)" },
	{ tag: [t.processingInstruction, t.meta], color: "var(--muted-foreground)" },
	{ tag: t.contentSeparator, color: "var(--muted-foreground)" },
	{ tag: [t.keyword, t.atom], color: "var(--lh-link)" },
	{ tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
]);

function wrap(view: EditorView, before: string, after = before): boolean {
	view.dispatch(
		view.state.changeByRange((range) => {
			const text = view.state.sliceDoc(range.from, range.to);
			// Toggle off when already wrapped.
			const outer = view.state.sliceDoc(range.from - before.length, range.to + after.length);
			if (outer.startsWith(before) && outer.endsWith(after) && outer.length >= before.length + after.length) {
				return {
					changes: [
						{ from: range.from - before.length, to: range.from, insert: "" },
						{ from: range.to, to: range.to + after.length, insert: "" },
					],
					range: EditorSelection.range(range.from - before.length, range.to - before.length),
				};
			}
			return {
				changes: { from: range.from, to: range.to, insert: before + text + after },
				range: EditorSelection.range(range.from + before.length, range.to + before.length),
			};
		}),
	);
	return true;
}

function toggleTask(view: EditorView): boolean {
	const changes = [];
	for (const r of view.state.selection.ranges) {
		const line = view.state.doc.lineAt(r.head);
		const m = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s/.exec(line.text);
		if (m) {
			changes.push({ from: line.from, to: line.to, insert: Notes.toggleTaskText(line.text, localDate(Date.now())) });
		} else {
			const lm = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line.text);
			if (lm) changes.push({ from: line.from + lm[0].length, insert: "[ ] " });
			else {
				const indent = /^\s*/.exec(line.text)![0].length;
				changes.push({ from: line.from + indent, insert: "- [ ] " });
			}
		}
	}
	view.dispatch({ changes });
	return true;
}

function insertLink(view: EditorView): boolean {
	const r = view.state.selection.main;
	const text = view.state.sliceDoc(r.from, r.to);
	if (/^https?:\/\//.test(text)) {
		view.dispatch({ changes: { from: r.from, to: r.to, insert: `[](${text})` }, selection: { anchor: r.from + 1 } });
	} else {
		view.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}]]` }, selection: { anchor: r.from + 2 + text.length } });
	}
	return true;
}

/** Smart list continuation: Enter on "- item" makes "- ", Enter on an empty item ends the list. */
function continueList(view: EditorView): boolean {
	const r = view.state.selection.main;
	if (!r.empty) return false;
	const line = view.state.doc.lineAt(r.head);
	if (r.head !== line.to) return false;
	const m = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line.text);
	if (!m) {
		const q = /^(\s*>+\s?)(.*)$/.exec(line.text);
		if (q && q[2]!.trim()) {
			view.dispatch({ changes: { from: r.head, insert: "\n" + q[1] }, selection: { anchor: r.head + 1 + q[1]!.length } });
			return true;
		}
		return false;
	}
	const [, indent, bullet, num, delim, space, task, rest] = m;
	if (!rest!.trim()) {
		view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
		return true;
	}
	const marker = bullet ? bullet : `${Number(num) + 1}${delim}`;
	const insert = `\n${indent}${marker}${space}${task ? "[ ] " : ""}`;
	view.dispatch({ changes: { from: r.head, insert }, selection: { anchor: r.head + insert.length }, scrollIntoView: true });
	return true;
}

export function NoteEditor({
	docKey,
	initial,
	mode,
	host,
	onChange,
	onCursorLine,
	readOnly,
	scrollToLine,
	handleRef,
	spellcheck = true,
	vim = false,
}: {
	/** Changing this replaces the document (another note). */
	docKey: string;
	initial: string;
	mode: "live" | "source";
	host: EditorHost;
	onChange: (text: string) => void;
	onCursorLine?: (line: number) => void;
	readOnly?: boolean;
	scrollToLine?: { line: number; nonce: number } | null;
	handleRef?: React.MutableRefObject<NoteEditorHandle | null>;
	spellcheck?: boolean;
	vim?: boolean;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const hostRef = useRef(host);
	hostRef.current = host;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onCursorRef = useRef(onCursorLine);
	onCursorRef.current = onCursorLine;
	const modeRef = useRef(mode);
	modeRef.current = mode;
	const roCompartment = useRef(new Compartment());
	void vim;

	useEffect(() => {
		const h = () => hostRef.current;
		const completeLinks = (ctx: CompletionContext): CompletionResult | null => {
			const before = ctx.matchBefore(/!?\[\[[^\]\n]*/);
			if (!before) return null;
			const open = before.text.indexOf("[[") + 2;
			const query = before.text.slice(open);
			const from = before.from + open;
			const hash = query.indexOf("#");
			if (hash >= 0) {
				const target = query.slice(0, hash);
				const path = target ? h().resolve(target) : null;
				const heads = path ? h().headingsOf(path) : [];
				return {
					from: from + hash + 1,
					options: heads.map((hd) => ({ label: hd, type: "text", apply: (view: EditorView, _c: unknown, f: number, to: number) => {
						const after = view.state.sliceDoc(to, to + 2) === "]]" ? "" : "]]";
						view.dispatch({ changes: { from: f, to, insert: hd + after }, selection: { anchor: f + hd.length + 2 } });
					} })),
					validFor: /^[^\]|]*$/,
				};
			}
			if (query.includes("|")) return null;
			return {
				from,
				options: h()
					.noteOptions()
					.map((o) => ({
						label: o.label,
						detail: o.detail,
						type: "text",
						apply: (view: EditorView, _c: unknown, f: number, to: number) => {
							const text = h().linkText(o.path);
							const after = view.state.sliceDoc(to, to + 2) === "]]" ? "" : "]]";
							view.dispatch({ changes: { from: f, to, insert: text + after }, selection: { anchor: f + text.length + 2 } });
						},
					})),
				validFor: /^[^\]#|]*$/,
			};
		};
		const completeTags = (ctx: CompletionContext): CompletionResult | null => {
			const m = ctx.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]*/u);
			if (!m) return null;
			const hashAt = m.text.indexOf("#");
			const line = ctx.state.doc.lineAt(ctx.pos);
			if (m.from + hashAt === line.from && /^#+\s/.test(line.text)) return null;
			if (m.text.length - hashAt < 2 && !ctx.explicit) return null;
			return {
				from: m.from + hashAt + 1,
				options: h()
					.tagOptions()
					.map((tg) => ({ label: tg.tag, detail: String(tg.count), type: "keyword" })),
				validFor: /^[\p{L}\p{N}_\-/]*$/u,
			};
		};

		const clickHandler = EditorView.domEventHandlers({
			mousedown: (e, view) => {
				const target = e.target as HTMLElement;
				const link = target.closest(".cm-wikilink, .cm-lp-link, .cm-tag") as HTMLElement | null;
				if (!link) return false;
				const mod = e.metaKey || e.ctrlKey;
				if (link.classList.contains("cm-tag")) {
					if (!mod) return false;
					e.preventDefault();
					h().openTag(link.dataset.tag ?? "");
					return true;
				}
				const rendered = link.classList.contains("cm-lp-live") || link.classList.contains("cm-lp-link");
				if (!mod && !(rendered && modeRef.current === "live")) return false;
				e.preventDefault();
				if (link.classList.contains("cm-lp-link")) {
					const href = link.dataset.href ?? "";
					if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener");
					else if (href) h().openLink(decodeURIComponent(href).replace(/\.md$/i, ""), mod && e.shiftKey);
					return true;
				}
				const inner = link.dataset.target ?? "";
				h().openLink(inner.split("|")[0]!, mod && e.altKey);
				return true;
			},
			paste: (e, view) => {
				const files = [...(e.clipboardData?.files ?? [])];
				if (files.length) {
					e.preventDefault();
					void h().upload(files).then((paths) => {
						const insert = paths.map((p) => `![[${h().linkText(p)}]]`).join("\n");
						const r = view.state.selection.main;
						view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length } });
					});
					return true;
				}
				const text = e.clipboardData?.getData("text/plain") ?? "";
				const r = view.state.selection.main;
				if (!r.empty && /^https?:\/\/\S+$/.test(text.trim())) {
					const sel = view.state.sliceDoc(r.from, r.to);
					if (/^https?:\/\//.test(sel)) return false;
					e.preventDefault();
					const insert = `[${sel}](${text.trim()})`;
					view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length } });
					return true;
				}
				return false;
			},
			drop: (e, view) => {
				const files = [...(e.dataTransfer?.files ?? [])];
				const notePath = e.dataTransfer?.getData("application/x-lh-note");
				if (notePath) {
					e.preventDefault();
					const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
					const insert = `[[${h().linkText(notePath)}]]`;
					view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
					return true;
				}
				if (!files.length) return false;
				e.preventDefault();
				const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
				void h().upload(files).then((paths) => {
					const insert = paths.map((p) => `![[${h().linkText(p)}]]`).join("\n");
					view.dispatch({ changes: { from: pos, insert } });
				});
				return true;
			},
		});

		const extensions: Extension[] = [
			history(),
			drawSelection(),
			dropCursor(),
			highlightActiveLine(),
			EditorView.lineWrapping,
			indentUnit.of("\t"),
			EditorState.tabSize.of(4),
			markdown({ base: markdownLanguage, addKeymap: true }),
			syntaxHighlighting(highlight),
			closeBrackets(),
			autocompletion({ override: [completeLinks, completeTags], icons: false, activateOnTyping: true }),
			search({ top: true }),
			highlightSelectionMatches(),
			livePreview({
				resolve: (x) => h().resolve(x),
				rawHref: (p) => h().rawHref(p),
				isImage: (p) => h().isImage(p),
				enabled: () => modeRef.current === "live",
			}),
			placeholder("Start writing…   [[ links a note · # adds a tag"),
			EditorView.contentAttributes.of({ spellcheck: spellcheck ? "true" : "false", autocapitalize: "sentences" }),
			roCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
			keymap.of([
				{ key: "Enter", run: continueList },
				{ key: "Mod-b", run: (v) => wrap(v, "**") },
				{ key: "Mod-i", run: (v) => wrap(v, "*") },
				{ key: "Mod-Shift-x", run: (v) => wrap(v, "~~") },
				{ key: "Mod-Shift-h", run: (v) => wrap(v, "==") },
				{ key: "Mod-e", run: (v) => wrap(v, "`") },
				{ key: "Mod-k", run: insertLink },
				{ key: "Mod-l", run: toggleTask },
				{ key: "Mod-Enter", run: toggleTask },
				{ key: "Alt-ArrowUp", run: moveLineUp },
				{ key: "Alt-ArrowDown", run: moveLineDown },
				...searchKeymap,
				...historyKeymap,
				indentWithTab,
				...defaultKeymap,
			]),
			clickHandler,
			EditorView.updateListener.of((u) => {
				if (u.docChanged) onChangeRef.current(u.state.doc.toString());
				if (u.selectionSet || u.docChanged) onCursorRef.current?.(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
			}),
		];
		const view = new EditorView({
			state: EditorState.create({ doc: initial, extensions }),
			parent: parent.current!,
		});
		viewRef.current = view;
		if (handleRef) handleRef.current = { view };
		return () => {
			view.destroy();
			viewRef.current = null;
			if (handleRef) handleRef.current = { view: null };
		};
		// docKey replaces the editor; `initial` is read only at mount.
	}, [docKey]);

	useEffect(() => {
		if (viewRef.current) refreshLivePreview(viewRef.current);
	}, [mode, host]);

	useEffect(() => {
		viewRef.current?.dispatch({ effects: roCompartment.current.reconfigure(EditorState.readOnly.of(!!readOnly)) });
	}, [readOnly]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || !scrollToLine) return;
		const n = Math.min(Math.max(1, scrollToLine.line + 1), view.state.doc.lines);
		const line = view.state.doc.line(n);
		view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 40 }) });
		view.focus();
	}, [scrollToLine]);

	return <div ref={parent} className="lh-note-editor h-full" data-lh-notes-keys="" data-testid="note-editor" />;
}
