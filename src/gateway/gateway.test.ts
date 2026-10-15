import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { UsageMeter } from "./meter.js";
import { createGateway } from "./server.js";

const ADMIN = "a".repeat(40);
const TOKEN = "t".repeat(40);

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("UsageMeter", () => {
  it("meters a stream split at awkward places", () => {
    const text = sse([
      { type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 100_000 } },
    ]);
    const m = new UsageMeter();
    for (let i = 0; i < text.length; i += 7) m.pushSse(text.slice(i, i + 7));
    expect(m.costUsd()).toBeCloseTo(4 + 2, 6); // $4 input + $2 output
  });
});

describe("gateway", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(upstreamBody: string, contentType: string) {
    const seen: { headers?: Headers; url?: string } = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = new Headers(init.headers as Record<string, string>);
      return new Response(upstreamBody, { status: 200, headers: { "content-type": contentType } });
    }) as unknown as typeof fetch;
    const { server } = createGateway({ apiKey: "sk-real", adminToken: ADMIN, upstream: "https://up", fetchImpl });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, seen };
  }

  const admin = (base: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" } });

  it("swaps the token for the real key, meters, and enforces the budget", async () => {
    const body = JSON.stringify({ model: "claude-opus-5-5", usage: { input_tokens: 500_000, output_tokens: 0 } });
    const { base, seen } = await start(body, "application/json");
    expect((await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": TOKEN }, body: "{}" })).status).toBe(401);
    expect((await admin(base, "/admin/tokens", { method: "POST", body: JSON.stringify({ token: TOKEN, budgetUsd: 3 }) })).status).toBe(201);

    const call = () =>
      fetch(`${base}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": TOKEN, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-opus-5-5" }) });
    expect((await call()).status).toBe(200);
    expect(seen.headers!.get("x-api-key")).toBe("sk-real");
    expect(seen.headers!.get("anthropic-version")).toBe("2023-06-01");
    expect(seen.url).toBe("https://up/v1/messages?beta=true");
    expect((await call()).status).toBe(200); // $2 + $2 = $4 > $3
    const r = await call();
    expect(r.status).toBe(429);
    const usage = (await (await admin(base, `/admin/tokens/${TOKEN}`)).json()) as { spentUsd: number };
    expect(usage.spentUsd).toBeCloseTo(4);
  });

  it("refuses other endpoints and bad admin tokens", async () => {
    const { base } = await start("{}", "application/json");
    await admin(base, "/admin/tokens", { method: "POST", body: JSON.stringify({ token: TOKEN, budgetUsd: 1 }) });
    expect((await fetch(`${base}/v1/models`, { method: "POST", headers: { "x-api-key": TOKEN }, body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/admin/tokens/${TOKEN}`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("passes SSE through untouched while metering it", async () => {
    const stream = sse([
      { type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 1_000_000 } } },
      { type: "message_delta", usage: { output_tokens: 0 } },
    ]);
    const { base } = await start(stream, "text/event-stream");
    await admin(base, "/admin/tokens", { method: "POST", body: JSON.stringify({ token: TOKEN, budgetUsd: 10 }) });
    const res = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true }) });
    expect(await res.text()).toBe(stream);
    const usage = (await (await admin(base, `/admin/tokens/${TOKEN}`)).json()) as { spentUsd: number };
    expect(usage.spentUsd).toBeCloseTo(2);
  });
});
