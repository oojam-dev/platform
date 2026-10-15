/** Display helpers shared by server and client. Dates are formatted in UTC so SSR and hydration agree. */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 123456 → "$1,234.56"; -250 → "−$2.50". */
export function money(cents: number): string {
  const s = usd.format(Math.abs(cents) / 100);
  return cents < 0 ? `−${s}` : s;
}

/** Signed money for adjustments: "+$5.00", "−$1.00". */
export function signedMoney(cents: number): string {
  return cents > 0 ? `+${money(cents)}` : money(cents);
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d) : d;
}

/** "14 Oct 2026" */
export function day(d: Date | string): string {
  const x = toDate(d);
  return `${x.getUTCDate()} ${months[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** "14 Oct 2026, 19:43 UTC" */
export function dateTime(d: Date | string): string {
  const x = toDate(d);
  const hh = String(x.getUTCHours()).padStart(2, "0");
  const mm = String(x.getUTCMinutes()).padStart(2, "0");
  return `${day(x)}, ${hh}:${mm} UTC`;
}

/** "3h ago", relative to a fixed `now` (pass the loader's time so SSR and hydration agree). */
export function ago(d: Date | string, now: Date | string | number): string {
  const ms = toDate(typeof now === "number" ? new Date(now) : now).getTime() - toDate(d).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const dd = Math.round(h / 24);
  if (dd < 60) return `${dd}d ago`;
  return day(d);
}

/** Seconds → "05:12:33". */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
