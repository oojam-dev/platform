/** GET /ideas/:id/og.png — the 1200×630 share preview for an idea. */
import { getIdea } from "../../src/core/ideas.js";
import { nextFreeze } from "../../src/core/time.js";
import { getDb } from "../../src/db/client.js";
import { countdownText, renderIdeaOg } from "../lib/og.server";
import type { Route } from "./+types/ideas.$id.og";

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const idea = Number.isSafeInteger(id) && id > 0 ? await getIdea(getDb(), id) : undefined;
  if (!idea || idea.hiddenAt) return new Response("Not found", { status: 404 });
  const png = await renderIdeaOg({
    title: idea.title,
    author: idea.author,
    voteCount: idea.voteCount,
    status: idea.status,
    countdown: countdownText(nextFreeze()),
  });
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "Content-Length": String(png.length),
    },
  });
}
