import type { ReactNode } from "react";
import { Link } from "react-router";

import { useRootData } from "~/lib/root-data";

/** Hidden CSRF field for every mutating form. */
export function CsrfInput() {
  const root = useRootData();
  return <input type="hidden" name="csrf" value={root?.csrf ?? ""} />;
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} aria-label="oojam">
      <span aria-hidden="true" className="text-jam">
        oo
      </span>
      <span aria-hidden="true">jam</span>
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: "jam" | "ink" | "ok" | "warn" | "muted" }> = {
  open: { label: "Open", tone: "muted" },
  screening: { label: "Screening…", tone: "warn" },
  frozen: { label: "Frozen", tone: "ink" },
  building: { label: "Building", tone: "jam" },
  deployed: { label: "Built", tone: "ok" },
  failed: { label: "Failed", tone: "warn" },
  rejected: { label: "Rejected", tone: "warn" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
  hidden: { label: "Hidden", tone: "warn" },
  // builds
  queued: { label: "Queued", tone: "muted" },
  gating: { label: "Checking", tone: "jam" },
  pr_open: { label: "PR open", tone: "jam" },
  merging: { label: "Merging", tone: "jam" },
  deploying: { label: "Deploying", tone: "jam" },
  rolled_back: { label: "Rolled back", tone: "warn" },
  skipped: { label: "Skipped", tone: "muted" },
  // deployments
  candidate: { label: "Candidate", tone: "jam" },
  live: { label: "Live", tone: "ok" },
  retired: { label: "Retired", tone: "muted" },
};

const TONES = {
  jam: "bg-jam-soft text-jam-ink",
  ink: "bg-ink text-paper",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  muted: "bg-sunk text-ink-2",
};

export function StatusChip({ status, className = "" }: { status: string; className?: string }) {
  const s = STATUS[status] ?? { label: status, tone: "muted" as const };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${TONES[s.tone]} ${className}`}
    >
      {s.tone === "jam" && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </span>
  );
}

export function Avatar({ src, login, size = 24 }: { src: string | null | undefined; login: string; size?: number }) {
  const ok = src && /^https:\/\/avatars\.githubusercontent\.com\//.test(src);
  if (!ok) {
    return (
      <span
        aria-hidden="true"
        className="inline-grid shrink-0 place-items-center rounded-full bg-jam-soft font-bold text-jam-ink"
        style={{ width: size, height: size, fontSize: size * 0.45 }}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const url = new URL(src);
  url.searchParams.set("s", String(size * 2));
  return (
    <img
      src={url.toString()}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-full bg-sunk"
      style={{ width: size, height: size }}
    />
  );
}

export function Author({ login, avatar, size = 18 }: { login: string; avatar: string | null; size?: number }) {
  return (
    <a
      href={`https://github.com/${encodeURIComponent(login)}`}
      className="inline-flex items-center gap-1.5 font-medium text-ink-2 hover:text-ink"
      rel="nofollow noopener"
    >
      <Avatar src={avatar} login={login} size={size} />
      <span>@{login}</span>
    </a>
  );
}

/** Markdown already rendered server-side by markdown-it with html disabled. */
export function Markdown({ html, className = "" }: { html: string; className?: string }) {
  return <div className={`prose-oo ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Notice({
  tone = "info",
  title,
  children,
  className = "",
}: {
  tone?: "info" | "ok" | "warn" | "jam";
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-line bg-sunk text-ink",
    ok: "border-transparent bg-ok-soft text-ok",
    warn: "border-transparent bg-warn-soft text-warn",
    jam: "border-transparent bg-jam-soft text-jam-ink",
  };
  return (
    <div
      role={tone === "warn" ? "alert" : "status"}
      className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed ${tones[tone]} ${className}`}
    >
      {title && <p className="font-bold">{title}</p>}
      {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
    </div>
  );
}

export function PageTitle({ kicker, title, children }: { kicker?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8 max-w-2xl">
      {kicker && <p className="kicker mb-2">{kicker}</p>}
      <h1 className="font-display text-3xl font-black leading-[1.05] tracking-tight text-balance sm:text-[2.6rem]">
        {title}
      </h1>
      {children && <div className="mt-3 text-[1.0625rem] leading-relaxed text-ink-2 text-pretty">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, accent = false }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={`card p-5 ${accent ? "border-transparent bg-jam text-on-jam" : ""}`}>
      <p className={`text-xs font-bold uppercase tracking-wider ${accent ? "opacity-80" : "text-ink-3"}`}>{label}</p>
      <p className="num mt-2 font-display text-3xl font-black tracking-tight">{value}</p>
      {hint && <p className={`mt-1 text-sm ${accent ? "opacity-85" : "text-ink-2"}`}>{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div aria-hidden="true" className="mb-5 flex gap-1.5">
        <span className="size-5 rounded-full bg-jam" />
        <span className="size-5 rounded-full bg-jam opacity-60" />
      </div>
      <h2 className="font-display text-2xl font-black tracking-tight text-balance">{title}</h2>
      {children && <div className="mt-2 max-w-md text-ink-2 text-pretty">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-6 inline-flex items-center gap-1 text-sm font-semibold text-ink-2 hover:text-ink">
      <span aria-hidden="true">←</span> {children}
    </Link>
  );
}

export function HeartIcon({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} fill="currentColor" className="shrink-0 text-jam">
      <path d="M8 14.25s-5.75-3.4-5.75-7.6A3.15 3.15 0 0 1 8 4.3a3.15 3.15 0 0 1 5.75 2.35c0 4.2-5.75 7.6-5.75 7.6Z" />
    </svg>
  );
}

/** "oojam runs on donated Anthropic credits…" — on /fund and in How it works. */
export function SponsorCard({ url, compact = false }: { url: string; compact?: boolean }) {
  return (
    <div className={`rounded-2xl bg-jam-soft text-jam-ink ${compact ? "p-4" : "p-6"}`}>
      <p className={`flex items-center gap-2 font-display font-black tracking-tight ${compact ? "text-base" : "text-xl"}`}>
        <HeartIcon size={compact ? 16 : 20} /> Sponsor oojam
      </p>
      <p className={`mt-1.5 leading-relaxed ${compact ? "text-sm" : ""}`}>
        oojam runs on donated Anthropic credits. Sponsoring pays for builds — it never buys votes.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener"
        className={`btn btn-jam mt-4 ${compact ? "btn-sm" : ""}`}
      >
        Become a sponsor <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
