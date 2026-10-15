import { useEffect, useId, useRef, useState } from "react";

import { useRootData } from "~/lib/root-data";

export type ShareChannel = "native" | "copy" | "x" | "bluesky" | "linkedin" | "reddit" | "hackernews" | "email";

/** The URL a viewer shares: the idea's URL, with ?ref=<their login> when signed in. */
export function useShareUrl(ideaId: number): string {
  const root = useRootData();
  const base = `${root?.platformUrl ?? ""}/ideas/${ideaId}`;
  return root?.user ? `${base}?ref=${encodeURIComponent(root.user.login)}` : base;
}

export function shareText(title: string, isAuthor: boolean): string {
  return isAuthor ? `Vote for my idea to get it built at oojam: ${title}` : `Help get this built at oojam: ${title}`;
}

function record(ideaId: number, channel: ShareChannel) {
  try {
    const body = new URLSearchParams({ channel });
    void fetch(`/ideas/${ideaId}/share`, { method: "POST", body, keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    /* counting is best-effort */
  }
}

function intents(url: string, text: string, title: string) {
  const e = encodeURIComponent;
  return [
    { channel: "x" as const, label: "X", href: `https://x.com/intent/tweet?text=${e(text)}&url=${e(url)}` },
    { channel: "bluesky" as const, label: "Bluesky", href: `https://bsky.app/intent/compose?text=${e(`${text} ${url}`)}` },
    { channel: "linkedin" as const, label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${e(url)}` },
    { channel: "reddit" as const, label: "Reddit", href: `https://www.reddit.com/submit?url=${e(url)}&title=${e(title)}` },
    { channel: "hackernews" as const, label: "Hacker News", href: `https://news.ycombinator.com/submitlink?u=${e(url)}&t=${e(title)}` },
    { channel: "email" as const, label: "Email", href: `mailto:?subject=${e(text)}&body=${e(`${text}\n\n${url}`)}` },
  ];
}

function ShareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13V3M6 7l4-4 4 4" />
      <path d="M4 11v4.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V11" />
    </svg>
  );
}

/**
 * Share an idea: the native share sheet where there is one (phones), otherwise a menu of
 * copy-link and the usual networks. Every pick is counted via POST /ideas/:id/share.
 */
export function ShareButton({
  ideaId,
  title,
  isAuthor,
  variant = "default",
}: {
  ideaId: number;
  title: string;
  isAuthor: boolean;
  variant?: "default" | "icon" | "primary";
}) {
  const url = useShareUrl(ideaId);
  const text = shareText(title, isAuthor);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const [canNative, setCanNative] = useState(false);
  useEffect(() => setCanNative(typeof navigator.share === "function"), []);

  async function nativeShare(): Promise<boolean> {
    try {
      await navigator.share({ title, text, url });
      record(ideaId, "native");
      return true;
    } catch (error) {
      return error instanceof DOMException && error.name === "AbortError";
    }
  }

  async function onClick() {
    // Touch devices go straight to the native share sheet. Desktops get our menu (with the
    // system sheet as one option), since desktop sheets rarely list HN, Reddit or Bluesky.
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (coarse && canNative && (await nativeShare())) return;
    setOpen((o) => !o);
  }

  const [manual, setManual] = useState(false);
  async function copy() {
    record(ideaId, "copy");
    try {
      // Some browsers never settle the promise without permission; don't wait forever.
      await Promise.race([
        navigator.clipboard.writeText(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setManual(true); // show the link to copy by hand
    }
  }

  const btn =
    variant === "icon"
      ? "inline-flex size-8 items-center justify-center rounded-full text-ink-3 hover:bg-sunk hover:text-ink"
      : variant === "primary"
        ? "btn btn-jam"
        : "btn btn-ghost btn-sm";

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        className={btn}
        onClick={onClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={variant === "icon" ? `Share “${title}”` : undefined}
        title={variant === "icon" ? "Share" : undefined}
      >
        <ShareIcon size={variant === "icon" ? 17 : 16} />
        {variant !== "icon" && <span>{variant === "primary" ? "Share it" : "Share"}</span>}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-60 origin-top-right rounded-2xl border border-line bg-card p-1.5 shadow-xl shadow-black/10"
        >
          <button
            type="button"
            role="menuitem"
            onClick={copy}
            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-sunk"
          >
            {copied ? "Copied!" : "Copy link"}
            <span aria-hidden="true" className="text-ink-3">
              {copied ? "✓" : "⧉"}
            </span>
          </button>
          {canNative && (
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                setOpen(false);
                await nativeShare();
              }}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-sunk"
            >
              More options…
            </button>
          )}
          {manual && (
            <label className="block px-3 pb-2">
              <span className="text-[0.6875rem] text-ink-3">Copy this link:</span>
              <input
                readOnly
                value={url}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                className="field mt-1 py-1.5 font-mono text-xs"
              />
            </label>
          )}
          <span role="status" className="sr-only">
            {copied ? "Link copied" : ""}
          </span>
          <div className="my-1 border-t border-line" />
          {intents(url, text, title).map((i) => (
            <a
              key={i.channel}
              role="menuitem"
              href={i.href}
              target={i.channel === "email" ? undefined : "_blank"}
              rel="noopener noreferrer"
              onClick={() => {
                record(ideaId, i.channel);
                setOpen(false);
              }}
              className="flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium hover:bg-sunk"
            >
              {i.label}
              <span aria-hidden="true" className="text-ink-3">
                ↗
              </span>
            </a>
          ))}
          <p className="mt-1 border-t border-line px-3 pt-2 pb-1 text-[0.6875rem] leading-snug text-ink-3">
            {url.includes("?ref=") ? "Your link credits you when people vote through it." : "Sign in to get credit for votes you bring in."}
          </p>
        </div>
      )}
    </div>
  );
}
