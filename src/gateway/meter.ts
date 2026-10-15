/** Pulls usage out of Messages API responses, JSON or SSE, as they stream past (SPEC §4.3). */
import { costUsd, type Usage } from "../core/pricing.js";

export class UsageMeter {
  private usage: Usage = {};
  private buffer = "";
  model: string | undefined;

  constructor(model?: string) {
    this.model = model;
  }

  /** Feed raw SSE text as it arrives. */
  pushSse(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const event = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        this.onEvent(JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* not JSON; ignore */
      }
    }
  }

  private onEvent(e: Record<string, unknown>): void {
    if (e.type === "message_start") {
      const m = e.message as { model?: string; usage?: Usage } | undefined;
      if (m?.model) this.model = m.model;
      if (m?.usage) this.merge(m.usage);
    } else if (e.type === "message_delta" && e.usage) {
      this.merge(e.usage as Usage);
    }
  }

  /** A whole JSON response body. */
  pushJson(body: string): void {
    try {
      const j = JSON.parse(body) as { model?: string; usage?: Usage };
      if (j.model) this.model = j.model;
      if (j.usage) this.merge(j.usage);
    } catch {
      /* ignore */
    }
  }

  /** Later events carry cumulative counts; keep the largest seen for each field. */
  private merge(u: Usage): void {
    const max = (a: number | null | undefined, b: number | null | undefined) => Math.max(a ?? 0, b ?? 0);
    this.usage = {
      input_tokens: max(this.usage.input_tokens, u.input_tokens),
      output_tokens: max(this.usage.output_tokens, u.output_tokens),
      cache_read_input_tokens: max(this.usage.cache_read_input_tokens, u.cache_read_input_tokens),
      cache_creation_input_tokens: max(this.usage.cache_creation_input_tokens, u.cache_creation_input_tokens),
      cache_creation: {
        ephemeral_5m_input_tokens: max(this.usage.cache_creation?.ephemeral_5m_input_tokens, u.cache_creation?.ephemeral_5m_input_tokens),
        ephemeral_1h_input_tokens: max(this.usage.cache_creation?.ephemeral_1h_input_tokens, u.cache_creation?.ephemeral_1h_input_tokens),
      },
      speed: u.speed ?? this.usage.speed,
    };
  }

  costUsd(): number {
    return costUsd(this.model, this.usage);
  }
}
