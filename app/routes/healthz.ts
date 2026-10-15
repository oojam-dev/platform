/** GET /healthz — liveness plus a database round-trip. */
import { getDb } from "../../src/db/client.js";
import { ping } from "../lib/queries.server";

export async function loader() {
  try {
    await ping(getDb());
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("healthz: database check failed:", error);
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
