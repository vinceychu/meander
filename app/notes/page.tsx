import { Suspense } from "react";
import { NotesApp } from "@/components/notes/notes-app";

/** Notes (2026-11-06): the Obsidian-style Markdown vault. */
export default function NotesPage() {
	return (
		<Suspense fallback={null}>
			<NotesApp />
		</Suspense>
	);
}
