/** USD per million tokens (SPEC §9). Unknown models are priced as the dearest known one. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
};

const DEAREST: ModelPrice = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export function priceFor(model: string | undefined): ModelPrice {
  if (!model) return DEAREST;
  if (PRICES[model]) return PRICES[model];
  // Tolerate suffixed ids (e.g. a dated snapshot) by prefix.
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key]! : DEAREST;
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  speed?: string | null;
}

/** Cost in USD of one response's usage. Fast mode is billed at 2x. */
export function costUsd(model: string | undefined, u: Usage): number {
  const p = priceFor(model);
  const n = (x: number | null | undefined) => (typeof x === "number" && x > 0 ? x : 0);
  const w5 = n(u.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = n(u.cache_creation?.ephemeral_1h_input_tokens);
  // Older responses report only the total; price it as 5-minute writes.
  const wUnsplit = Math.max(0, n(u.cache_creation_input_tokens) - w5 - w1);
  const usd =
    (n(u.input_tokens) * p.input +
      n(u.output_tokens) * p.output +
      n(u.cache_read_input_tokens) * p.cacheRead +
      (w5 + wUnsplit) * p.cacheWrite5m +
      w1 * p.cacheWrite1h) /
    1_000_000;
  return u.speed === "fast" ? usd * 2 : usd;
}

export const usdToCents = (usd: number) => Math.ceil(usd * 100);
