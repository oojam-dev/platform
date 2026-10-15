/** GET /oembed?url=<idea url>&format=json — oEmbed (https://oembed.com) for idea pages. */
import { config } from "../../src/core/config.js";
import { getIdea } from "../../src/core/ideas.js";
import { getDb } from "../../src/db/client.js";
import type { Route } from "./+types/oembed";

const W = 480;
const H = 200;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams;
  const format = q.get("format") ?? "json";
  if (format !== "json") return new Response("Only format=json is supported", { status: 501 });

  const base = new URL(config.platformUrl);
  let target: URL;
  try {
    target = new URL(q.get("url") ?? "");
  } catch {
    return Response.json({ error: "url is required" }, { status: 400 });
  }
  const m = /^\/(?:embed\/)?ideas\/(\d+)\/?$/.exec(target.pathname);
  if (target.host !== base.host || !m) return Response.json({ error: "not an oojam idea url" }, { status: 404 });

  const idea = await getIdea(getDb(), Number(m[1]));
  if (!idea || idea.hiddenAt) return Response.json({ error: "not found" }, { status: 404 });

  const maxW = Number(q.get("maxwidth")) || Infinity;
  const maxH = Number(q.get("maxheight")) || Infinity;
  const width = Math.max(280, Math.min(W, maxW));
  const height = Math.max(160, Math.min(H, maxH));
  const origin = base.origin;
  const src = `${origin}/embed/ideas/${idea.id}`;

  return Response.json(
    {
      version: "1.0",
      type: "rich",
      provider_name: "oojam",
      provider_url: origin,
      title: idea.title,
      author_name: idea.author,
      author_url: `https://github.com/${encodeURIComponent(idea.author)}`,
      width,
      height,
      html: `<iframe src="${esc(src)}" width="${width}" height="${height}" style="border:0;border-radius:16px;max-width:100%" loading="lazy" title="${esc(`oojam idea: ${idea.title}`)}"></iframe>`,
      thumbnail_url: `${origin}/ideas/${idea.id}/og.png`,
      thumbnail_width: 1200,
      thumbnail_height: 630,
      cache_age: 300,
    },
    { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } },
  );
}
