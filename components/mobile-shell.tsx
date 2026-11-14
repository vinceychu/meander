"use client";
/**
 * MOBILE SHELL (Meander, 2026-11-14) — makes the phone/iOS app feel native.
 * Phone only (≤767px, the sidebar's PHONE_MAX); desktop is untouched.
 *  - Edge swipe right (from the left 28px)  → open the sessions drawer; swipe left anywhere while open → close it.
 *  - Edge swipe left (from the right 28px)  → back.
 *  - Bottom tab bar: Learn · Chats · Notes · Courses · Review, with the iPhone home-indicator safe area.
 *    Hidden while typing (keyboard up) so it never covers the composer.
 *  - Light haptic tick on tab change where the platform supports it.
 * Self-contained so upstream LearnHarness merges don't conflict: it only reads the sidebar context.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BookOpenIcon, FileTextIcon, MessageSquareIcon, RepeatIcon, SparklesIcon } from "lucide-react";
import { useSidebar } from "@/components/sidebar";

const EDGE = 28, MIN_DX = 60, MAX_SLOPE = 0.6;

function tick() {
	try { (navigator as Navigator & { vibrate?: (n: number) => boolean }).vibrate?.(8); } catch { /* no haptics */ }
}

export function MobileShell() {
	const { open, toggle, close, phone } = useSidebar();
	const router = useRouter();
	const path = usePathname() ?? "/";
	const [typing, setTyping] = useState(false);
	const start = useRef<{ x: number; y: number; edge: "left" | "right" | null; t: number } | null>(null);

	// keyboard up = an input/textarea/contenteditable has focus → hide the tab bar
	useEffect(() => {
		if (!phone) return;
		const isField = (el: Element | null) =>
			!!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable);
		const on = () => setTyping(isField(document.activeElement));
		document.addEventListener("focusin", on); document.addEventListener("focusout", () => setTimeout(on, 50));
		return () => { document.removeEventListener("focusin", on); };
	}, [phone]);

	// swipe gestures
	useEffect(() => {
		if (!phone) return;
		const ts = (e: TouchEvent) => {
			if (e.touches.length !== 1) { start.current = null; return; }
			const t = e.touches[0]!; const w = window.innerWidth;
			const edge = t.clientX <= EDGE ? "left" : t.clientX >= w - EDGE ? "right" : null;
			start.current = { x: t.clientX, y: t.clientY, edge, t: Date.now() };
		};
		const te = (e: TouchEvent) => {
			const s = start.current; start.current = null;
			if (!s) return;
			const t = e.changedTouches[0]!; const dx = t.clientX - s.x, dy = t.clientY - s.y;
			if (Math.abs(dx) < MIN_DX || Math.abs(dy) > Math.abs(dx) * MAX_SLOPE || Date.now() - s.t > 800) return;
			// never hijack horizontal scrolling inside code blocks, tables, graphs or the notes editor
			const target = e.target as HTMLElement | null;
			if (!s.edge && target?.closest("pre, table, canvas, .cm-editor, [data-no-swipe]")) return;
			if (dx > 0 && s.edge === "left" && !open) { toggle(); tick(); }
			else if (dx < 0 && open) { close(); tick(); }
			else if (dx < 0 && s.edge === "right" && !open && path !== "/") { router.back(); tick(); }
		};
		document.addEventListener("touchstart", ts, { passive: true });
		document.addEventListener("touchend", te, { passive: true });
		return () => { document.removeEventListener("touchstart", ts); document.removeEventListener("touchend", te); };
	}, [phone, open, toggle, close, router, path]);

	// reserve room for the bar so nothing hides under it
	useEffect(() => {
		const root = document.documentElement;
		if (phone && !typing) root.classList.add("lh-tabbar"); else root.classList.remove("lh-tabbar");
		return () => root.classList.remove("lh-tabbar");
	}, [phone, typing]);

	if (!phone || typing) return null;
	const tabs: { key: string; label: string; icon: typeof BookOpenIcon; active: boolean; go: () => void }[] = [
		{ key: "learn", label: "Learn", icon: SparklesIcon, active: path === "/" || path.startsWith("/chat"), go: () => { if (open) close(); router.push("/"); } },
		{ key: "chats", label: "Chats", icon: MessageSquareIcon, active: open, go: () => toggle() },
		{ key: "notes", label: "Notes", icon: FileTextIcon, active: path.startsWith("/notes"), go: () => { if (open) close(); router.push("/notes"); } },
		{ key: "courses", label: "Courses", icon: BookOpenIcon, active: path.startsWith("/courses"), go: () => { if (open) close(); router.push("/courses"); } },
		{ key: "review", label: "Review", icon: RepeatIcon, active: path.startsWith("/stats"), go: () => { if (open) close(); router.push("/stats"); } },
	];
	return (
		<nav
			data-testid="mobile-tabbar"
			aria-label="Main"
			className="fixed inset-x-0 bottom-0 z-[60] flex border-t border-border/60 bg-background/90 backdrop-blur-md"
			style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
		>
			{tabs.map(({ key, label, icon: Icon, active, go }) => (
				<button
					key={key}
					type="button"
					data-testid={`tab-${key}`}
					aria-current={active ? "page" : undefined}
					onClick={() => { tick(); go(); }}
					className={"flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] tracking-wide transition-colors active:scale-95 " +
						(active ? "text-foreground" : "text-muted-foreground")}
				>
					<Icon aria-hidden="true" className={"size-5 " + (active ? "stroke-[2.2]" : "")} />
					{label}
				</button>
			))}
		</nav>
	);
}
