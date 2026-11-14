import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { MobileShell } from "@/components/mobile-shell";
import { ThemeProvider } from "@/components/theme";
import { themeBootScript } from "@/components/theme-boot";
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot } from "@/src/server";
import { effectiveColors, themeForMode, themeVars } from "@/src/core";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Meander",
	// Phone home-screen install (2026-10-27): full-screen, named, dark status bar.
	appleWebApp: { capable: true, title: "Meander", statusBarStyle: "black" },
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export const viewport: Viewport = { themeColor: "#141818", viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	// MEANDER day/night: the device's sun/moon mode lives in localStorage,
	// so the boot script swaps to the other variant's counterpart pre-paint.
	const alt = themeForMode(theme, theme.mode === "dark" ? "light" : "dark");
	const altVars = themeVars(effectiveColors(alt, appearance), alt.mode);
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeBootScript(theme.mode, altVars) }} />
			</head>
			<body className="min-h-dvh antialiased">
			<ThemeProvider>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
								{/* Phone app feel (2026-11-14): swipes + bottom tab bar. */}
								<MobileShell />
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			</ThemeProvider>
		</body>
		</html>
	);
}
