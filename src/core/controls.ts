import { eq } from "drizzle-orm";

import type { DbOrTx } from "../db/client.js";
import { auditLog, controls } from "../db/schema.js";

export interface PausedState {
  paused: boolean;
  reason: string;
}

export async function getPaused(db: DbOrTx): Promise<PausedState> {
  const [row] = await db.select().from(controls).where(eq(controls.key, "paused"));
  const v = row?.value as Partial<PausedState> | undefined;
  return { paused: Boolean(v?.paused), reason: v?.reason ?? "" };
}

export async function setPaused(db: DbOrTx, actorId: number | null, state: PausedState): Promise<void> {
  await db
    .insert(controls)
    .values({ key: "paused", value: state, updatedBy: actorId })
    .onConflictDoUpdate({ target: controls.key, set: { value: state, updatedBy: actorId, updatedAt: new Date() } });
  await audit(db, actorId, state.paused ? "pause" : "resume", "system", { reason: state.reason });
}

/** Everything admins and the system do to other people's things is public (/transparency). */
export async function audit(
  db: DbOrTx,
  actorId: number | null,
  action: string,
  subject: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({ actorId, action, subject, data });
}
