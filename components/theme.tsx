"use client";
/**
 * Light/dark switch (2026-11-06). The mode is a per-device preference
 * (localStorage "lh:theme": "dark" | "light" | "system"), applied as the
 * `dark` class on <html>. THEME_BOOT_SCRIPT runs before first paint (inlined
 * in app/layout.tsx) so a light-mode reload never flashes dark.
 *
 * Every surface is token-driven (app/globals.css :root = day, .dark = night),
 * so flipping the class is the whole switch; canvas/diagram renderers that
 * bake colors read `useTheme().resolved` to re-render.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

export type ThemeMode = "dark" | "light" | "system";
export const THEME_KEY = "lh:theme";

export const THEME_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem("${THEME_KEY}")||"dark";var d=m==="system"?matchMedia("(prefers-color-scheme: dark)").matches:m!=="light";var c=document.documentElement.classList;d?c.add("dark"):c.remove("dark");}catch(e){}})();`;

function readMode(): ThemeMode {
	try {
		const v = localStorage.getItem(THEME_KEY);
		return v === "light" || v === "system" ? v : "dark";
	} catch {
		return "dark";
	}
}

function systemDark(): boolean {
	return typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches;
}

interface ThemeValue {
	mode: ThemeMode;
	resolved: "dark" | "light";
	setMode: (mode: ThemeMode) => void;
	toggle: () => void;
}

const ThemeContext = createContext<ThemeValue>({ mode: "dark", resolved: "dark", setMode: () => {}, toggle: () => {} });

export function useTheme() {
	return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [mode, setModeState] = useState<ThemeMode>("dark");
	const [sysDark, setSysDark] = useState(true);
	useEffect(() => {
		setModeState(readMode());
		setSysDark(systemDark());
		const mq = matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setSysDark(mq.matches);
		mq.addEventListener("change", onChange);
		const onStorage = (e: StorageEvent) => {
			if (e.key === THEME_KEY) setModeState(readMode());
		};
		window.addEventListener("storage", onStorage);
		return () => {
			mq.removeEventListener("change", onChange);
			window.removeEventListener("storage", onStorage);
		};
	}, []);
	const resolved: "dark" | "light" = mode === "system" ? (sysDark ? "dark" : "light") : mode;
	useEffect(() => {
		document.documentElement.classList.toggle("dark", resolved === "dark");
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute("content", resolved === "dark" ? "#141818" : "#faf9f6");
	}, [resolved]);
	const setMode = useCallback((next: ThemeMode) => {
		setModeState(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			/* private mode: the switch still works for this page */
		}
	}, []);
	const toggle = useCallback(() => setMode(resolved === "dark" ? "light" : "dark"), [resolved, setMode]);
	const value = useMemo(() => ({ mode, resolved, setMode, toggle }), [mode, resolved, setMode, toggle]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The sun/moon button (sidebar footer, notes toolbar). */
export function ThemeToggle({ className = "" }: { className?: string }) {
	const { resolved, toggle } = useTheme();
	const label = resolved === "dark" ? "Switch to day mode" : "Switch to night mode";
	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={label}
			title={label}
			data-testid="theme-toggle"
			className={`flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${className}`}
		>
			{resolved === "dark" ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
		</button>
	);
}
