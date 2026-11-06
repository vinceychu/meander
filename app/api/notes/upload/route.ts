/**
 * POST /api/notes/upload — attachments (pasted/dropped images, PDFs, audio).
 * Multipart: "files" + optional "folder" (default "attachments"). Name
 * collisions get " 1", " 2"… like Obsidian. Returns the vault paths.
 */
import { Notes } from "@/src/core";
import { notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(req: Request) {
	const form = await req.formData().catch(() => null);
	if (!form) return Response.json({ error: "Expected multipart form data" }, { status: 400 });
	const folder = Notes.cleanNotePath(form.get("folder") ?? "attachments") ?? "attachments";
	const saved: string[] = [];
	for (const entry of form.getAll("files")) {
		if (typeof entry === "string") continue;
		if (entry.size > MAX_BYTES) return Response.json({ error: `${entry.name} is over 50 MB` }, { status: 413 });
		const rawName = (entry.name || "Pasted image.png").replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "file";
		const ext = Notes.extOf(rawName);
		if (!(Notes.ATTACHMENT_EXTS as readonly string[]).includes(ext)) return Response.json({ error: `${rawName}: unsupported file type` }, { status: 415 });
		const stem = rawName.slice(0, rawName.length - ext.length);
		let path = `${folder}/${stem}${ext}`;
		for (let i = 1; notesVault.exists(path); i++) path = `${folder}/${stem} ${i}${ext}`;
		try {
			notesVault.writeBinary(path, new Uint8Array(await entry.arrayBuffer()));
			saved.push(path);
		} catch (err) {
			return Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 400 });
		}
	}
	return Response.json({ paths: saved });
}
