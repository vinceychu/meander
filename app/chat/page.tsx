import { redirect } from "next/navigation";
// /chat (no id) used to 404 (2026-11-14): send it to a new session.
export default function ChatIndex() { redirect("/chat/new"); }
