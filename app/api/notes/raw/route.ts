/** GET /api/notes/raw?path=… — an attachment's bytes (images, PDFs, audio). */
import { Notes } from "@/src/core";
import { notesVault } from "@/src/server";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".pdf": "application/pdf",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "video/webm",
	".mov": "video/quicktime", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

export function GET(req: Request) {
	const path = Notes.cleanNotePath(new URL(req.url).searchParams.get("path"));
	if (!path) return new Response("Invalid path", { status: 400 });
	const data = notesVault.readBinary(path);
	if (!data) return new Response("Not found", { status: 404 });
	const type = TYPES[Notes.extOf(path)] ?? "application/octet-stream";
	return new Response(new Uint8Array(data), {
		headers: {
			"Content-Type": type,
			"Cache-Control": "private, max-age=60",
			// SVGs from a vault never run script in the app's origin.
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
