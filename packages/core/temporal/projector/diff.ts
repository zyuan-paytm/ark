import type { DatabaseAdapter } from "../../database/index.js";

export interface ProjectionDiff {
  sessionId: string;
  field: string;
  realValue: unknown;
  shadowValue: unknown;
}

/**
 * Compare real projections (Temporal) against shadow projections (bespoke + stub activities).
 * Returns an array of diffs -- empty means parity.
 */
export async function diffProjections(db: DatabaseAdapter, sessionId: string): Promise<ProjectionDiff[]> {
  const real = (await db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId)) as
    | Record<string, unknown>
    | undefined;
  const shadowRow = (await db
    .prepare("SELECT * FROM session_projections_shadow WHERE session_id=? AND stage_idx IS NULL")
    .get(sessionId)) as Record<string, unknown> | undefined;

  if (!real || !shadowRow) return [];

  // patch_json stores the accumulated projection patch written by shadow-mode activities.
  const shadowPatch: Record<string, unknown> =
    shadowRow.patch_json ? JSON.parse(shadowRow.patch_json as string) : {};

  const COMPARE_FIELDS = ["status", "stage", "error", "pr_url"] as const;
  const diffs: ProjectionDiff[] = [];
  for (const field of COMPARE_FIELDS) {
    if (real[field] !== shadowPatch[field]) {
      diffs.push({ sessionId, field, realValue: real[field], shadowValue: shadowPatch[field] });
    }
  }
  return diffs;
}
