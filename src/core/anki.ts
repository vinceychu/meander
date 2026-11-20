/**
 * ANKI EXPORT (fork, 2026-10-27) — the knowledge graph as an Anki deck.
 *
 * Output is Anki's native text import format (Anki 2.1.55+, File → Import):
 * header lines declare the separator, note type, deck and columns, so the
 * import needs no field mapping. One Basic note per proposition:
 *   front = the name, back = the statement.
 * The first column is a stable GUID ("lh-<node id>"), so re-importing a
 * newer export UPDATES the existing cards (and keeps their Anki review
 * history) instead of duplicating them.
 *
 * Tags: "meander", plus "lh_due" for propositions currently due in
 * Meander's own schedule (review.ts) — filter on it in Anki.
 * Math: "$…$" / "$$…$$" become Anki's MathJax "\(…\)" / "\[…\]".
 *
 * Pure + browser-safe.
 */

export const ANKI_DECK = "Meander";

/** HTML-escape, keep line breaks, and convert TeX delimiters for Anki's MathJax. */
export function ankiField(text: string): string {
	const html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\$\$([\s\S]+?)\$\$/g, (_, m: string) => `\\[${m}\\]`)
		.replace(/\$([^$\n]+?)\$/g, (_, m: string) => `\\(${m}\\)`)
		.replace(/\t/g, " ")
		.replace(/\r?\n/g, "<br>");
	return html;
}

export function ankiExportText(
	nodes: ReadonlyArray<{ id: string; name: string; statement: string }>,
	dueIds: ReadonlySet<string> = new Set(),
	deck: string = ANKI_DECK,
): string {
	const lines = [
		"#separator:tab",
		"#html:true",
		"#notetype:Basic",
		`#deck:${deck}`,
		"#guid column:1",
		"#tags column:4",
	];
	for (const n of nodes) {
		const tags = dueIds.has(n.id) ? "meander lh_due" : "meander";
		lines.push([`lh-${n.id}`, ankiField(n.name), ankiField(n.statement), tags].join("\t"));
	}
	return lines.join("\n") + "\n";
}
