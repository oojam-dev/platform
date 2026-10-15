/**
 * POST /ideas/:id/share {channel} — counts a share click. No CSRF: it's a counter that changes
 * nothing anyone owns. Rate-limited per IP (and per IP+idea) so it can't be pumped.
 */
import { SHARE_CHANNELS, recordShare } from "../../src/core/referrals.js";
import { getDb } from "../../src/db/client.js";
import { clientIp, rateLimit } from "../lib/rate-limit.server";
import { optionalUser, readForm } from "../lib/session.server";
import type { Route } from "./+types/ideas.$id.share";

const CHANNELS = new Set<string>(SHARE_CHANNELS);

export async function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function action({ request, params }: Route.ActionArgs) {
  const ideaId = Number(params.id);
  const form = await readForm(request);
  const channel = String(form.get("channel") ?? "");
  if (!Number.isSafeInteger(ideaId) || ideaId <= 0 || !CHANNELS.has(channel)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  const ip = clientIp(request);
  if (!rateLimit(`share:${ip}`, 30, 10 * 60_000) || !rateLimit(`share:${ip}:${ideaId}:${channel}`, 3, 60 * 60_000)) {
    return Response.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  const user = await optionalUser(request);
  try {
    await recordShare(getDb(), { ideaId, userId: user?.id ?? null, channel });
  } catch (error) {
    console.error("share: failed to record:", error);
    return Response.json({ ok: false }, { status: 500 });
  }
  return Response.json({ ok: true });
}
