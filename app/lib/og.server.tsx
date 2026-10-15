/**
 * 1200×630 preview images for shared ideas: satori lays out JSX into SVG with a bundled font
 * (Nunito, from @fontsource; satori can't read woff2, so the .woff files), then resvg
 * rasterises it to PNG. Fonts are read once per process.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type * as ResvgModule from "@resvg/resvg-js";
import satori from "satori";

const require = createRequire(import.meta.url);
// A native addon: loaded with require at runtime so Vite's dependency scanner leaves it alone.
const { Resvg } = require("@resvg/resvg-js") as typeof ResvgModule;

type Weight = 400 | 700 | 800 | 900;
let fonts: Promise<{ name: string; data: Buffer; weight: Weight; style: "normal" }[]> | undefined;

function loadFonts() {
  fonts ??= Promise.all(
    ([400, 700, 800, 900] as const).map(async (weight) => ({
      name: "Nunito",
      weight,
      style: "normal" as const,
      data: await readFile(require.resolve(`@fontsource/nunito/files/nunito-latin-${weight}-normal.woff`)),
    })),
  );
  return fonts;
}

const C = { paper: "#faf6f0", ink: "#1c1714", ink2: "#574e47", jam: "#c40e4f", jamSoft: "#fce8ef", line: "#e6ddd1" };

export interface OgIdea {
  title: string;
  author: string;
  voteCount: number;
  status: string;
  /** e.g. "Next build in 5h" */
  countdown: string;
}

function statusLine(i: OgIdea): string {
  if (i.status === "deployed") return "Built and live on oojam.dev";
  if (i.status === "frozen" || i.status === "building") return "Being built right now";
  return i.countdown;
}

export async function renderIdeaOg(idea: OgIdea): Promise<Buffer> {
  const title = idea.title.length > 110 ? `${idea.title.slice(0, 108)}…` : idea.title;
  const titleSize = title.length > 80 ? 60 : title.length > 45 ? 72 : 84;

  const svg = await satori(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: C.paper,
        padding: "56px 72px",
        fontFamily: "Nunito",
        color: C.ink,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 56, fontWeight: 900, letterSpacing: -3 }}>
          <span style={{ color: C.jam }}>oo</span>
          <span>jam</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 28,
            fontWeight: 800,
            color: C.jam,
            backgroundColor: C.jamSoft,
            borderRadius: 999,
            padding: "10px 26px",
          }}
        >
          {statusLine(idea)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: titleSize, fontWeight: 900, lineHeight: 1.05, letterSpacing: -2 }}>{title}</div>
        <div style={{ display: "flex", marginTop: 22, fontSize: 32, fontWeight: 700, color: C.ink2 }}>@{idea.author}</div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `3px solid ${C.line}`,
          paddingTop: 30,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontSize: 64, fontWeight: 900 }}>{idea.voteCount.toLocaleString("en-US")}</span>
          <span style={{ fontSize: 32, fontWeight: 700, color: C.ink2, marginLeft: 14 }}>
            {idea.voteCount === 1 ? "vote" : "votes"}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 32,
            fontWeight: 800,
            color: "#ffffff",
            backgroundColor: C.jam,
            borderRadius: 999,
            padding: "16px 34px",
          }}
        >
          Vote at build.oojam.dev
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, fonts: await loadFonts() },
  );

  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: false } }).render().asPng();
}

/** "Next build in 5h" / "Next build in 12m". */
export function countdownText(target: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60_000));
  if (mins >= 120) return `Next build in ${Math.round(mins / 60)}h`;
  if (mins >= 60) return `Next build in 1h ${mins - 60}m`;
  return mins <= 0 ? "Building now" : `Next build in ${mins}m`;
}
