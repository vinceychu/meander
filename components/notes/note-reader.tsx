"use client";
/**
 * Reading view (2026-11-06): the note rendered with the app's Markdown
 * stack (math, mermaid, code, tables — the same renderer as lessons), after
 * core/notes.ts preprocessForReading turns Obsidian syntax into links,
 * images, transclusions, highlights and tag pills. Callouts (> [!type]) get
 * their colored box; checkboxes toggle the source; images open full-screen.
 */
import { Children, isValidElement, memo, useMemo, type ReactNode } from "react";
import { Notes } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { mdComponents } from "@/components/md-blocks";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
	return "";
}

export const NoteReader = memo(function NoteReader({
	text,
	resolve,
	readNote,
	onOpen,
	onTag,
	onCreate,
	onToggleTask,
}: {
	text: string;
	resolve: (target: string) => string | null;
	readNote: (path: string) => string | null;
	onOpen: (path: string, sub: string | null, newTab: boolean) => void;
	onTag: (tag: string) => void;
	onCreate: (title: string) => void;
	onToggleTask: (index: number) => void;
}) {
	const md = useMemo(() => Notes.preprocessForReading(text, { resolve, readNote }), [text, resolve, readNote]);
	const hasEmbeds = /!\[\[[^\]]+\]\]/.test(text);

	const components = useMemo(() => {
		const A = ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => {
			const h = href ?? "";
			if (h.startsWith("/notes?")) {
				const u = new URL(h, "http://x");
				const open = u.searchParams.get("open");
				const tag = u.searchParams.get("tag");
				const create = u.searchParams.get("create");
				const cls = tag ? "lh-note-tag" : create ? "lh-note-link lh-note-link-unresolved" : "lh-note-link";
				return (
					<a
						href={h}
						className={cls}
						onClick={(e) => {
							e.preventDefault();
							if (open) onOpen(open, u.hash ? decodeURIComponent(u.hash.slice(1)) : null, e.metaKey || e.ctrlKey);
							else if (tag) onTag(tag);
							else if (create) onCreate(create);
						}}
					>
						{children}
					</a>
				);
			}
			if (h === "#lh-mark" || h.startsWith("#lh-mark-")) {
				const color = h.slice("#lh-mark-".length);
				return <mark data-color={color || undefined}>{children}</mark>;
			}
			if (h.startsWith("#")) {
				return (
					<a
						href={h}
						className="lh-note-link"
						onClick={(e) => {
							e.preventDefault();
							const id = decodeURIComponent(h.slice(1));
							const el = [...document.querySelectorAll(".lh-note-reading h1, .lh-note-reading h2, .lh-note-reading h3, .lh-note-reading h4, .lh-note-reading h5, .lh-note-reading h6")].find(
								(x) => Notes.slugHeading(x.textContent ?? "") === Notes.slugHeading(id),
							);
							el?.scrollIntoView({ behavior: "smooth", block: "start" });
						}}
					>
						{children}
					</a>
				);
			}
			return (
				<a href={h} target="_blank" rel="noreferrer noopener" className="lh-note-ext" {...rest}>
					{children}
				</a>
			);
		};
		const Img = ({ src, alt }: { src?: string | Blob; alt?: string }) => {
			const s = typeof src === "string" ? src : "";
			const m = /\|(\d+)(?:x(\d+))?$/.exec(alt ?? "");
			const width = m ? Number(m[1]) : undefined;
			const cleanAlt = (alt ?? "").replace(/\|\d+(x\d+)?$/, "");
			return (
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={s}
					alt={cleanAlt}
					style={width ? { width } : undefined}
					className="lh-note-img"
					onClick={() => window.dispatchEvent(new CustomEvent("lh:notes-lightbox", { detail: { src: s, alt: cleanAlt } }))}
				/>
			);
		};
		const Blockquote = ({ children }: { children?: ReactNode }) => {
			const kids = Children.toArray(children).filter((c) => !(typeof c === "string" && !c.trim()));
			const first = kids[0];
			const firstText = textOf(first);
			const m = /^\s*\[!(\w+)\]([+-]?)\s*(.*)/s.exec(firstText);
			if (!m) return <blockquote className="lh-note-quote">{children}</blockquote>;
			const type = m[1]!.toLowerCase();
			const fold = m[2];
			// Title = rest of the first line; body = the remainder of the paragraph + other children.
			const [titleLine, ...restLines] = m[3]!.split("\n");
			let titleNode: ReactNode = titleLine || type.charAt(0).toUpperCase() + type.slice(1);
			if (type === "embed" && isValidElement(first)) {
				// The embed header is a link — keep it as a node.
				const pk = Children.toArray((first.props as { children?: ReactNode }).children);
				const link = pk.find((c) => isValidElement(c));
				if (link) titleNode = link;
			}
			const body = (
				<>
					{restLines.join("\n").trim() ? <p>{restLines.join("\n")}</p> : null}
					{kids.slice(1)}
				</>
			);
			if (fold) {
				return (
					<details className={`lh-callout lh-callout-${type}`} open={fold === "+"}>
						<summary className="lh-callout-title">
							<span className="lh-callout-icon">{Notes.calloutIcon(type)}</span>
							{titleNode}
						</summary>
						<div className="lh-callout-body">{body}</div>
					</details>
				);
			}
			return (
				<div className={`lh-callout lh-callout-${type}`}>
					<div className="lh-callout-title">
						{type !== "embed" && <span className="lh-callout-icon">{Notes.calloutIcon(type)}</span>}
						{titleNode}
					</div>
					<div className="lh-callout-body">{body}</div>
				</div>
			);
		};
		const Input = (props: { type?: string; checked?: boolean }) => {
			if (props.type !== "checkbox") return <input {...props} />;
			// Index by DOM order at click time (blocks render independently).
			return (
				<input
					type="checkbox"
					checked={!!props.checked}
					disabled={hasEmbeds}
					className="lh-note-task"
					onChange={(e) => {
						const root = e.currentTarget.closest(".lh-note-reading");
						const all = root ? [...root.querySelectorAll("input.lh-note-task")] : [];
						onToggleTask(all.indexOf(e.currentTarget));
					}}
				/>
			);
		};
		return { ...mdComponents, a: A, img: Img, blockquote: Blockquote, input: Input };
		// md changes reset the task counter via a fresh components object.
	}, [md, onOpen, onTag, onCreate, onToggleTask, hasEmbeds]);

	return (
		<div className="lh-note-reading">
			<MessageResponse components={components as never}>{md}</MessageResponse>
		</div>
	);
});
