/**
 * THE COURSE MODEL SEAM — the cheap-slot model the generic adapter reads
 * a course with (2026-11-09).
 *
 * The generic adapter has no idea what a syllabus looks like, so it asks
 * the model: the pages go in, the outline comes out, validated against a
 * schema. The call goes through the app's existing background path (the
 * extraction sub-agent's runner), on the CHEAP slot — this is a cheap,
 * mechanical reading job, not a tutoring job.
 *
 * The engine is resolved from the settings chain (role override → slot →
 * nothing), exactly like every other background role. No model configured
 * means no outline — reported honestly, never faked.
 */

import type { ModelRole } from "../../../config.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { stores } from "../stores.ts";

/** The engine for one role (undefined when the chain came up empty). */
export function engineForRole(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec, true) : undefined;
}
