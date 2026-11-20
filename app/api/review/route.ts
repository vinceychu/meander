/**
 * GET /api/review — the spaced-review queue (fork, 2026-10-26): which
 * propositions have decayed below 90% predicted recall, most urgent first,
 * plus the upcoming ones. Derived on every call (src/server/review.ts).
 */

import { reviewSnapshot } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(reviewSnapshot());
}
