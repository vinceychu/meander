/**
 * The day/night pre-paint script (Meander, 2026-11-13). A plain module —
 * not "use client" — so the server layout can call it. See components/theme.tsx.
 */

/** localStorage key for this device's mode: "dark" | "light" | "system"
 *  (absent = follow the record's theme). */
export const THEME_KEY = "lh:theme";

/** The pre-paint script: `serverMode` is the variant the layout rendered,
 *  `altVars` the counterpart's color variables (applied on a mismatch). */
export function themeBootScript(serverMode: "dark" | "light", altVars: Record<string, string>): string {
	return `(function(){try{var m=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(m!=="dark"&&m!=="light"&&m!=="system")return;var d=m==="system"?matchMedia("(prefers-color-scheme: dark)").matches:m!=="light";var r=d?"dark":"light";if(r===${JSON.stringify(serverMode)})return;var e=document.documentElement,c=e.classList;c.toggle("dark",d);c.toggle("light",!d);var v=${JSON.stringify(altVars).replace(/</g, "\\u003c")};for(var k in v)e.style.setProperty(k,v[k]);}catch(x){}})();`;
}
