"use client";
/**
 * Light/dark switch (2026-11-06). The mode is a per-device preference
 * (localStorage "lh:theme": "dark" | "light" | "system"). Merged onto the
 * upstream theme system (2026-11-13): the record's theme still picks the
 * palette, the switch picks the variant — a theme of the other variant
 * yields to its counterpart (core/themes.ts themeForMode), and the
 * AppearanceProvider applies the result (class + color variables). A
 * device that never touched the switch follows the record's theme.
 *
 * The server renders the record's theme on <html>; themeBootScript
 * (components/theme-boot.ts) runs before first paint (inlined in
 * app/layout.tsx) and swaps to the counterpart when this device's mode
 * disagrees, so a reload never flashes the wrong variant. The sun/moon
 * button is components/theme-toggle.tsx.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { THEME_KEY } from "./theme-boot.ts";

export { THEME_KEY };

export type ThemeMode = "dark" | "light" | "system";

function readMode(): ThemeMode | null {
	try {
		const v = localStorage.getItem(THEME_KEY);
		return v === "dark" || v === "light" || v === "system" ? v : null;
	} catch {
		return null;
	}
}

function systemDark(): boolean {
	return typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches;
}

interface ThemeValue {
	/** This device's stored mode; null = never set (follow the theme). */
	mode: ThemeMode | null;
	/** The variant the device asks for; null = whatever the theme is. */
	resolved: "dark" | "light" | null;
	/** False until this device's stored mode is read (the boot script
	 *  already painted it; the appearance provider waits rather than flash). */
	ready: boolean;
	setMode: (mode: ThemeMode) => void;
}

/** Outside a ThemeProvider (tests, bare renders): follow the theme. */
const ThemeContext = createContext<ThemeValue>({ mode: null, resolved: null, ready: true, setMode: () => {} });

export function useTheme() {
	return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [mode, setModeState] = useState<ThemeMode | null>(null);
	const [sysDark, setSysDark] = useState(true);
	const [ready, setReady] = useState(false);
	// A LAYOUT effect: the stored mode lands before the first paint.
	useLayoutEffect(() => {
		setModeState(readMode());
		setSysDark(systemDark());
		setReady(true);
	}, []);
	useEffect(() => {
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
	const resolved = mode === "system" ? (sysDark ? "dark" : "light") : mode;
	const setMode = useCallback((next: ThemeMode) => {
		setModeState(next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			/* private mode: the switch still works for this page */
		}
	}, []);
	const value = useMemo(() => ({ mode, resolved, ready, setMode }), [mode, resolved, ready, setMode]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
