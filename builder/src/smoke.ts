/**
 * Smoke test (SPEC §5.6): load each route in Chromium with the production CSP applied, and
 * fail on server errors, console errors, failed requests, CSP violations, or any request
 * to another origin. Usage: node dist/smoke.js <baseUrl> <route> [route…]. Prints JSON.
 */
import { chromium } from "playwright";

import { SITE_CSP } from "./csp.js";

export interface SmokeProblem {
  route: string;
  kind: "status" | "console" | "request" | "offsite" | "navigation";
  detail: string;
}

export async function smoke(baseUrl: string, routes: string[]): Promise<SmokeProblem[]> {
  const base = new URL(baseUrl);
  const problems: SmokeProblem[] = [];
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (const route of routes) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const add = (kind: SmokeProblem["kind"], detail: string) => problems.push({ route, kind, detail: detail.slice(0, 300) });

      // Apply the edge's CSP, so anything Caddy would block fails here too.
      await page.route("**/*", async (r) => {
        const url = new URL(r.request().url());
        if (url.origin !== base.origin) {
          add("offsite", `${r.request().method()} ${url.origin}${url.pathname}`);
          return r.abort();
        }
        const response = await r.fetch();
        const headers = { ...response.headers() };
        if (r.request().resourceType() === "document") headers["content-security-policy"] = SITE_CSP;
        return r.fulfill({ response, headers });
      });
      page.on("console", (m) => {
        if (m.type() === "error") add("console", m.text());
      });
      page.on("pageerror", (e) => add("console", e.message));
      page.on("requestfailed", (req) => {
        if (new URL(req.url()).origin === base.origin) add("request", `${req.url()}: ${req.failure()?.errorText ?? "failed"}`);
      });
      page.on("response", (res) => {
        if (res.status() >= 500) add("status", `${res.status()} ${res.url()}`);
      });
      try {
        const res = await page.goto(new URL(route, base).toString(), { waitUntil: "networkidle", timeout: 30_000 });
        if (!res) add("navigation", "no response");
        else if (res.status() >= 400) add("status", `${res.status()} for the page itself`);
        await page.waitForTimeout(500);
      } catch (error) {
        add("navigation", error instanceof Error ? error.message : String(error));
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return problems;
}

/** The site's health check must report ok before we look at pages. */
async function waitForHealth(baseUrl: string, timeoutMs = 90_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const res = await fetch(new URL("/_health", baseUrl));
      const body = (await res.json()) as { ok?: boolean };
      if (res.ok && body.ok) return;
      last = `${res.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`/_health never reported ok (${last})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [baseUrl, ...routes] = process.argv.slice(2);
  if (!baseUrl) {
    console.error("usage: smoke <baseUrl> <route>…");
    process.exit(2);
  }
  waitForHealth(baseUrl)
    .then(() => smoke(baseUrl, routes.length ? routes : ["/"]))
    .then((problems) => {
      process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, problems: [{ route: "*", kind: "navigation", detail: String(error) }] })}\n`);
    });
}
