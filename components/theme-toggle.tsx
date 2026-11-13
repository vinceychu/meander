"use client";
/** The sun/moon button (sidebar footer, notes toolbar): flips this device
 *  to the other variant of what is on screen (components/theme.tsx). */
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "@/components/theme";
import { useAppearance } from "@/components/settings/appearance";

export function ThemeToggle({ className = "" }: { className?: string }) {
	const { setMode } = useTheme();
	const { resolvedMode } = useAppearance();
	const label = resolvedMode === "dark" ? "Switch to day mode" : "Switch to night mode";
	return (
		<button
			type="button"
			onClick={() => setMode(resolvedMode === "dark" ? "light" : "dark")}
			aria-label={label}
			title={label}
			data-testid="theme-toggle"
			className={`flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${className}`}
		>
			{resolvedMode === "dark" ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
		</button>
	);
}
