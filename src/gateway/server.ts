/**
 * The Anthropic gateway (SPEC §4.3). Builders get a random per-build token instead of a key;
 * this swaps in the real key, forwards to api.anthropic.com, meters every response, and
 * refuses once a build's budget is spent. The worker manages tokens over the admin API.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { UsageMeter } from "./meter.js";

interface BuildToken {
  label: string;
  budgetUsd: number;
  spentUsd: number;
  requests: number;
  createdAt: number;
}

export interface GatewayOptions {
  apiKey: string;
  adminToken: string;
  upstream?: string;
  /** Tokens expire on their own after this long, in case the worker forgets them. */
  tokenTtlMs?: number;
  fetchImpl?: typeof fetch;
}

const FORWARDED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const DROP_REQUEST_HEADERS = new Set(["host", "x-api-key", "authorization", "content-length", "connection", "accept-encoding", "proxy-authorization"]);
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const MAX_BODY = 32 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function apiError(res: ServerResponse, status: number, type: string, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createGateway(opts: GatewayOptions): { server: Server; tokens: Map<string, BuildToken> } {
  const tokens = new Map<string, BuildToken>();
  const upstream = opts.upstream ?? "https://api.anthropic.com";
  const doFetch = opts.fetchImpl ?? fetch;
  const ttl = opts.tokenTtlMs ?? 3 * 3_600_000;

  const sweep = setInterval(() => {
    for (const [t, v] of tokens) if (Date.now() - v.createdAt > ttl) tokens.delete(t);
  }, 60_000);
  sweep.unref();

  async function admin(req: IncomingMessage, res: ServerResponse, path: string) {
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth, `Bearer ${opts.adminToken}`)) return apiError(res, 401, "authentication_error", "bad admin token");
    if (req.method === "POST" && path === "/admin/tokens") {
      const body = JSON.parse((await readBody(req)).toString("utf8")) as { token?: string; budgetUsd?: number; label?: string };
      if (!body.token || body.token.length < 32 || !(Number(body.budgetUsd) > 0)) return apiError(res, 400, "invalid_request_error", "token and budgetUsd required");
      tokens.set(body.token, { label: body.label ?? "", budgetUsd: Number(body.budgetUsd), spentUsd: 0, requests: 0, createdAt: Date.now() });
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
      return;
    }
    const m = /^\/admin\/tokens\/([^/]+)$/.exec(path);
    if (m) {
      const t = tokens.get(decodeURIComponent(m[1]!));
      if (req.method === "GET") {
        if (!t) return apiError(res, 404, "not_found_error", "no such token");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ spentUsd: t.spentUsd, budgetUsd: t.budgetUsd, requests: t.requests }));
        return;
      }
      if (req.method === "DELETE") {
        tokens.delete(decodeURIComponent(m[1]!));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(t ? { spentUsd: t.spentUsd } : {}));
        return;
      }
    }
    apiError(res, 404, "not_found_error", "not found");
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL) {
    const presented = (req.headers["x-api-key"] as string | undefined) ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const token = presented ? tokens.get(presented) : undefined;
    if (!token) return apiError(res, 401, "authentication_error", "invalid build token");
    if (req.method !== "POST" || !FORWARDED_PATHS.has(url.pathname)) return apiError(res, 404, "not_found_error", "not available through the oojam gateway");
    if (token.spentUsd >= token.budgetUsd) {
      return apiError(res, 429, "rate_limit_error", `This build's budget of $${token.budgetUsd.toFixed(2)} is spent. Finish up now.`);
    }
    const body = await readBody(req);
    let model: string | undefined;
    try {
      model = (JSON.parse(body.toString("utf8")) as { model?: string }).model;
    } catch {
      return apiError(res, 400, "invalid_request_error", "body must be JSON");
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(k) && typeof v === "string") headers[k] = v;
    }
    headers["x-api-key"] = opts.apiKey;
    headers["accept-encoding"] = "identity";
    token.requests++;

    const upstreamRes = await doFetch(`${upstream}${url.pathname}${url.search}`, { method: "POST", headers, body: new Uint8Array(body) });
    const outHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k)) outHeaders[k] = v;
    });
    res.writeHead(upstreamRes.status, outHeaders);
    const metered = url.pathname === "/v1/messages";
    const meter = new UsageMeter(model);
    const isSse = (upstreamRes.headers.get("content-type") ?? "").includes("text/event-stream");
    const decoder = new TextDecoder();
    let jsonBody = "";
    if (upstreamRes.body) {
      for await (const chunk of Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream)) {
        const buf = chunk as Buffer;
        res.write(buf);
        if (!metered) continue;
        const text = decoder.decode(buf, { stream: true });
        if (isSse) meter.pushSse(text);
        else jsonBody += text;
      }
    }
    res.end();
    if (metered) {
      if (!isSse) meter.pushJson(jsonBody);
      token.spentUsd += meter.costUsd();
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const handler = url.pathname === "/healthz"
      ? async () => void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}')
      : url.pathname.startsWith("/admin/")
        ? () => admin(req, res, url.pathname)
        : () => proxy(req, res, url);
    handler().catch((error: unknown) => {
      console.error("gateway:", error);
      if (!res.headersSent) apiError(res, 502, "api_error", "gateway error");
      else res.end();
    });
  });
  server.on("close", () => clearInterval(sweep));
  return { server, tokens };
}
