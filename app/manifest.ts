import type { MetadataRoute } from "next";

/** Installable web app (2026-10-27): "Add to Home Screen" on a phone opens
 *  Meander full-screen with its own icon. Icons are full-bleed squares —
 *  phones apply their own corner mask (rendered from build/icon-meander.svg). */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Meander",
		short_name: "Meander",
		description: "Learn anything with an AI teacher that remembers what you know.",
		start_url: "/",
		display: "standalone",
		background_color: "#141818",
		theme_color: "#141818",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
