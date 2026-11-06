/**
 * Live Preview for the notes editor (2026-11-06): Obsidian's editing mode —
 * Markdown syntax hides on every line the cursor is not on, so text reads
 * rendered while staying plain text. Headings grow, **marks** vanish,
 * [[links]] show their label, ![[images]] render under their line, task
 * markers become clickable checkboxes, bullets become dots, ==highlights==
 * tint, #tags pill, callout lines tint by type.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export interface LivePreviewHost {
	resolve: (target: string) => string | null;
	rawHref: (path: string) => string;
	isImage: (path: string) => boolean;
	enabled: () => boolean;
}

class CheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly pos: number) {
		super();
	}
	eq(o: CheckboxWidget) {
		return o.checked === this.checked && o.pos === this.pos;
	}
	toDOM(view: EditorView) {
		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = this.checked;
		box.className = "cm-lp-task";
		box.setAttribute("aria-label", this.checked ? "Mark not done" : "Mark done");
		box.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const ch = view.state.sliceDoc(this.pos, this.pos + 1);
			view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: ch === " " ? "x" : " " } });
		});
		return box;
	}
	ignoreEvent() {
		return true;
	}
}

class BulletWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const s = document.createElement("span");
		s.className = "cm-lp-bullet";
		s.textContent = "•";
		return s;
	}
}

class CalloutTitleWidget extends WidgetType {
	constructor(readonly type: string) {
		super();
	}
	eq(o: CalloutTitleWidget) {
		return o.type === this.type;
	}
	toDOM() {
		const s = document.createElement("span");
		s.className = "cm-lp-callout-title";
		s.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1);
		return s;
	}
}

class HrWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const s = document.createElement("span");
		s.className = "cm-lp-hr";
		return s;
	}
}

class ImageWidget extends WidgetType {
	constructor(readonly src: string, readonly width: number | null, readonly alt: string) {
		super();
	}
	eq(o: ImageWidget) {
		return o.src === this.src && o.width === this.width;
	}
	toDOM() {
		const wrap = document.createElement("div");
		wrap.className = "cm-lp-image";
		const img = document.createElement("img");
		img.src = this.src;
		img.alt = this.alt;
		img.loading = "lazy";
		if (this.width) img.style.width = `${this.width}px`;
		img.addEventListener("click", () => window.dispatchEvent(new CustomEvent("lh:notes-lightbox", { detail: { src: this.src, alt: this.alt } })));
		wrap.appendChild(img);
		return wrap;
	}
	ignoreEvent() {
		return false;
	}
}

function cursorLines(state: EditorState): Set<number> {
	const lines = new Set<number>();
	for (const r of state.selection.ranges) {
		const a = state.doc.lineAt(r.from).number;
		const b = state.doc.lineAt(r.to).number;
		for (let i = a; i <= b; i++) lines.add(i);
	}
	return lines;
}

const hide = Decoration.replace({});
const HEADING_CLASS = ["", "cm-lp-h1", "cm-lp-h2", "cm-lp-h3", "cm-lp-h4", "cm-lp-h5", "cm-lp-h6"];

function build(view: EditorView, host: LivePreviewHost): DecorationSet {
	const live = host.enabled();
	const state = view.state;
	const active = cursorLines(state);
	const focused = view.hasFocus;
	const onActive = (pos: number) => focused && active.has(state.doc.lineAt(pos).number);
	const decos: Range<Decoration>[] = [];
	const lineDeco = (pos: number, cls: string) => decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (node) => {
				const name = node.name;
				const h = /^ATXHeading(\d)$/.exec(name);
				if (h) {
					lineDeco(node.from, `cm-lp-heading ${HEADING_CLASS[Number(h[1])]}`);
					return;
				}
				if (name === "FencedCode") {
					for (let p = node.from; p <= node.to; ) {
						const line = state.doc.lineAt(p);
						lineDeco(line.from, "cm-lp-codeblock");
						p = line.to + 1;
					}
					return;
				}
				if (name === "Blockquote") {
					const first = state.doc.lineAt(node.from);
					const m = /^>\s*\[!(\w+)\]/.exec(first.text);
					for (let p = node.from; p <= node.to; ) {
						const line = state.doc.lineAt(p);
						lineDeco(line.from, m ? `cm-lp-callout cm-lp-callout-${m[1]!.toLowerCase()}` : "cm-lp-quote");
						p = line.to + 1;
					}
				}
				if (!live) return;
				if (onActive(node.from)) return;
				switch (name) {
					case "HeaderMark": {
						const end = Math.min(node.to + 1, state.doc.lineAt(node.from).to);
						decos.push(hide.range(node.from, end));
						break;
					}
					case "EmphasisMark":
					case "StrikethroughMark":
						decos.push(hide.range(node.from, node.to));
						break;
					case "CodeMark": {
						const parent = node.node.parent;
						if (parent?.name === "InlineCode") decos.push(hide.range(node.from, node.to));
						break;
					}
					case "QuoteMark": {
						const line = state.doc.lineAt(node.from);
						const after = state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
						if (!/^>\s*\[!\w+\]/.test(line.text) || node.from !== line.from) decos.push(hide.range(node.from, after));
						else decos.push(hide.range(node.from, after));
						break;
					}
					case "ListMark": {
						const text = state.sliceDoc(node.from, node.to);
						const next = node.node.nextSibling;
						if (next?.name === "Task") {
							decos.push(hide.range(node.from, Math.min(node.to + 1, next.from)));
						} else if (text === "-" || text === "*" || text === "+") {
							decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
						}
						break;
					}
					case "TaskMarker": {
						const ch = state.sliceDoc(node.from + 1, node.from + 2);
						decos.push(Decoration.replace({ widget: new CheckboxWidget(ch !== " ", node.from + 1) }).range(node.from, node.to));
						if (ch !== " ") {
							const line = state.doc.lineAt(node.from);
							if (node.to < line.to) decos.push(Decoration.mark({ class: "cm-lp-done" }).range(node.to, line.to));
						}
						break;
					}
					case "HorizontalRule":
						decos.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
						break;
					case "Link": {
						// [text](url) → text styled as a link. Reference-style
						// shortcuts ([x], [[x]], callout [!type]) are left alone:
						// wikilinks and callouts are handled below.
						if (!node.node.getChild("URL")) return false;
						const marks: { from: number; to: number }[] = [];
						let url: { from: number; to: number } | null = null;
						for (let c = node.node.firstChild; c; c = c.nextSibling) {
							if (c.name === "LinkMark") marks.push({ from: c.from, to: c.to });
							if (c.name === "URL") url = { from: c.from, to: c.to };
						}
						if (marks.length >= 2) {
							decos.push(hide.range(marks[0]!.from, marks[0]!.to));
							decos.push(Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": url ? state.sliceDoc(url.from, url.to) : "" } }).range(marks[0]!.to, marks[1]!.from));
							decos.push(hide.range(marks[1]!.from, node.to));
						}
						return false;
					}
					case "Image": {
						let url: string | null = null;
						for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "URL") url = state.sliceDoc(c.from, c.to);
						if (url) {
							const alt = /^!\[([^\]]*)\]/.exec(state.sliceDoc(node.from, node.to))?.[1] ?? "";
							const size = /\|(\d+)/.exec(alt);
							const src = /^[a-z]+:/i.test(url) ? url : host.resolve(decodeURIComponent(url)) ? host.rawHref(host.resolve(decodeURIComponent(url))!) : url;
							decos.push(Decoration.replace({ widget: new ImageWidget(src, size ? Number(size[1]) : null, alt) }).range(node.from, node.to));
						}
						return false;
					}
				}
			},
		});

		// Regex-level syntax the Markdown grammar doesn't know.
		const text = state.sliceDoc(from, to);
		const inCode = (pos: number) => {
			const n = syntaxTree(state).resolveInner(pos, 1);
			for (let c: typeof n | null = n; c; c = c.parent) if (/Code|CodeText|FencedCode|InlineCode/.test(c.name)) return true;
			return false;
		};
		for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
			const start = from + m.index!;
			const end = start + m[0].length;
			if (inCode(start)) continue;
			const inner = m[2]!;
			const bar = inner.indexOf("|");
			const target = (bar >= 0 ? inner.slice(0, bar) : inner).split("#")[0]!.trim();
			const resolved = target ? host.resolve(target) : "self";
			const cls = resolved ? "cm-wikilink" : "cm-wikilink cm-wikilink-unresolved";
			const embedImage = m[1] === "!" && resolved && resolved !== "self" && host.isImage(resolved);
			if (live && !onActive(start)) {
				if (embedImage) {
					const size = bar >= 0 && /^\d+/.test(inner.slice(bar + 1)) ? Number(/^\d+/.exec(inner.slice(bar + 1))![0]) : null;
					decos.push(Decoration.replace({ widget: new ImageWidget(host.rawHref(resolved), size, target) }).range(start, end));
					continue;
				}
				const labelFrom = bar >= 0 ? start + m[1]!.length + 2 + bar + 1 : start + m[1]!.length + 2;
				decos.push(hide.range(start, labelFrom));
				decos.push(Decoration.mark({ class: `${cls} cm-lp-live`, attributes: { "data-target": inner } }).range(labelFrom, end - 2));
				decos.push(hide.range(end - 2, end));
			} else {
				decos.push(Decoration.mark({ class: cls, attributes: { "data-target": inner } }).range(start, end));
			}
		}
		for (const m of text.matchAll(/==(?:\{(\w+)\})?([^=\n](?:[^=\n]|=(?!=))*?)==/g)) {
			const start = from + m.index!;
			if (inCode(start)) continue;
			const end = start + m[0].length;
			const openLen = 2 + (m[1] ? m[1].length + 2 : 0);
			const cls = `cm-lp-mark${m[1] ? ` cm-lp-mark-${m[1]}` : ""}`;
			if (live && !onActive(start)) {
				decos.push(hide.range(start, start + openLen));
				decos.push(Decoration.mark({ class: cls }).range(start + openLen, end - 2));
				decos.push(hide.range(end - 2, end));
			} else decos.push(Decoration.mark({ class: cls }).range(start, end));
		}
		for (const m of text.matchAll(/(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
			const start = from + m.index! + m[1]!.length;
			const line = state.doc.lineAt(start);
			if (/^#{1,6}\s/.test(line.text) && start === line.from) continue;
			if (inCode(start)) continue;
			decos.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": m[2]! } }).range(start, start + m[2]!.length + 1));
		}
		for (const m of text.matchAll(/^>\s*(\[!(\w+)\][+-]?)/gm)) {
			const start = from + m.index! + m[0].length - m[1]!.length;
			if (!live || onActive(start)) continue;
			const line = state.doc.lineAt(start);
			const rest = state.sliceDoc(start + m[1]!.length, line.to).trim();
			decos.push(Decoration.replace({ widget: new CalloutTitleWidget(rest ? "" : m[2]!) }).range(start, start + m[1]!.length));
		}
		for (const m of text.matchAll(/%%[^\n]*?%%/g)) {
			const start = from + m.index!;
			decos.push(Decoration.mark({ class: "cm-lp-comment" }).range(start, start + m[0].length));
		}
	}
	decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
	const builder = new RangeSetBuilder<Decoration>();
	let lastTo = -1;
	for (const d of decos) {
		// Replace decorations must not overlap; drop later overlapping ones.
		const isReplace = (d.value as unknown as { point?: boolean }).point === true;
		if (isReplace && d.from < lastTo) continue;
		try {
			builder.add(d.from, d.to, d.value);
		} catch {
			continue;
		}
		if (isReplace) lastTo = Math.max(lastTo, d.to);
	}
	return builder.finish();
}

export function livePreview(host: LivePreviewHost) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view, host);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.reconfigured)) this.decorations = build(u.view, host);
			}
		},
		{ decorations: (v) => v.decorations },
	);
}

/** Force a rebuild (mode switch, index change). */
export function refreshLivePreview(view: EditorView) {
	view.dispatch({ effects: [] , selection: view.state.selection });
}
