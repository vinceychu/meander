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
<<<<<<< HEAD
import { ThemeProvider, THEME_BOOT_SCRIPT } from "@/components/theme";
=======
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot } from "@/src/server";
>>>>>>> a63664767ebdd7e5af08f7f501b720e02b2ddc32

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

<<<<<<< HEAD
export const viewport: Viewport = { themeColor: "#141818" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`} suppressHydrationWarning>
			<head>
				{/* Light/dark (2026-11-06): set the class before first paint. */}
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
			</head>
=======
export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
>>>>>>> a63664767ebdd7e5af08f7f501b720e02b2ddc32
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
