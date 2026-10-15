import type { ReactNode } from "react";
import { Form, data, useNavigation } from "react-router";

import { banUser, requestWorker, unbanUser } from "../../src/core/admin.js";
import { getPaused, setPaused } from "../../src/core/controls.js";
import { RuleError } from "../../src/core/errors.js";
import { adjustFund, recordContribution } from "../../src/core/fund.js";
import { viralStats, type ViralStats } from "../../src/core/referrals.js";
import { getDb } from "../../src/db/client.js";
import { CsrfInput, Notice, PageTitle, StatusChip } from "../components/ui";
import { dateTime, day, money, signedMoney } from "../lib/format";
import { pendingWorkerRequests, recentDeployments, userByLogin } from "../lib/queries.server";
import { requireAdmin, requireMutation } from "../lib/session.server";
import type { Route } from "./+types/admin";

export const meta: Route.MetaFunction = () => [{ title: "Admin · oojam build" }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const db = getDb();
  const [paused, deployments, pending, week, month] = await Promise.all([
    getPaused(db),
    recentDeployments(db, 20),
    pendingWorkerRequests(db),
    viralStats(db, 7),
    viralStats(db, 30),
  ]);
  return { paused, deployments, pending, growth: [week, month] };
}

type Result = { ok: boolean; intent: string; message: string };

/** "12.50" → 1250; null when it isn't a sensible amount (max ±$100,000). */
function dollarsToCents(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) && Math.abs(cents) <= 10_000_000 ? cents : null;
}

export async function action({ request }: Route.ActionArgs) {
  const { user, form } = await requireMutation(request);
  if (!user.isAdmin) throw data("Admins only.", { status: 403 });
  const db = getDb();
  const intent = String(form.get("intent") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  const ok = (message: string): Result => ({ ok: true, intent, message });
  const fail = (message: string) => data<Result>({ ok: false, intent, message }, { status: 400 });

  const target = async () => {
    const login = String(form.get("login") ?? "");
    const u = await userByLogin(db, login);
    if (!u) throw new RuleError("not_found", `No oojam user with GitHub login “${login.trim()}”.`);
    return u;
  };

  try {
    switch (intent) {
      case "pause":
      case "resume": {
        if (!reason) return fail("A reason is required; it's shown in the banner and on /transparency.");
        await setPaused(db, user.id, { paused: intent === "pause", reason });
        return ok(intent === "pause" ? "The cycle is paused." : "The cycle is running again.");
      }
      case "run_cycle":
        await requestWorker(db, user.id, { type: "run_cycle" });
        return ok("Asked the worker to run today's cycle. It picks requests up within a minute.");
      case "rollback": {
        const deploymentId = Number(form.get("deploymentId"));
        if (!Number.isSafeInteger(deploymentId) || deploymentId <= 0) return fail("Pick a deployment.");
        await requestWorker(db, user.id, { type: "rollback", deploymentId });
        return ok(`Asked the worker to roll back to deployment #${deploymentId}.`);
      }
      case "ban": {
        const u = await target();
        if (u.id === user.id) return fail("You can't ban yourself.");
        await banUser(db, user.id, u.id, reason);
        return ok(`@${u.githubLogin} is banned and signed out.`);
      }
      case "unban": {
        const u = await target();
        await unbanUser(db, user.id, u.id, reason);
        return ok(`@${u.githubLogin} is unbanned.`);
      }
      case "contribution": {
        const cents = dollarsToCents(form.get("dollars"));
        if (cents === null || cents <= 0) return fail("Enter a positive dollar amount, e.g. 50 or 12.50.");
        const source = String(form.get("source") ?? "");
        await recordContribution(db, user.id, cents, source, String(form.get("note") ?? ""));
        return ok(`Recorded ${money(cents)} from ${source.trim()}.`);
      }
      case "adjust_fund": {
        const cents = dollarsToCents(form.get("dollars"));
        if (cents === null || cents === 0) return fail("Enter a non-zero dollar amount, e.g. 5 or -2.50.");
        await adjustFund(db, user.id, cents, reason);
        return ok(`Adjusted the fund by ${signedMoney(cents)}.`);
      }
      default:
        return fail("Unknown action.");
    }
  } catch (error) {
    if (error instanceof RuleError) return fail(error.message);
    throw error;
  }
}

function Panel({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="font-display text-lg font-black tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Submit({ intent, children, primary = false }: { intent: string; children: ReactNode; primary?: boolean }) {
  const nav = useNavigation();
  const busy = nav.state === "submitting" && nav.formData?.get("intent") === intent;
  return (
    <button type="submit" name="intent" value={intent} className={`btn ${primary ? "btn-jam" : "btn-ghost"}`} disabled={busy}>
      {busy ? "Working…" : children}
    </button>
  );
}

export default function Admin({ loaderData, actionData }: Route.ComponentProps) {
  const { paused, deployments, pending, growth } = loaderData;
  // Remount forms after a successful action so they clear.
  const actionKey = actionData?.ok ? `${actionData.intent}-${actionData.message}` : "form";
  const live = deployments.find((d) => d.status === "live");

  return (
    <>
      <PageTitle kicker="Admins only" title="Control room">
        Every action here is written to the public{" "}
        <a href="/transparency" className="link">
          transparency log
        </a>{" "}
        with its reason.
      </PageTitle>

      {actionData && (
        <Notice tone={actionData.ok ? "ok" : "warn"} className="mb-8">
          {actionData.message}
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title={paused.paused ? "The cycle is paused" : "The cycle is running"}
          description={
            paused.paused
              ? `Reason shown to everyone: “${paused.reason}”. No freeze, build, merge or deploy happens until you resume.`
              : "Pausing stops freezes, builds, merges and deploys, and shows a banner on both sites. Voting continues."
          }
        >
          <Form method="post" className="space-y-3" key={paused.paused ? "paused" : "running"}>
            <CsrfInput />
            <Field label={paused.paused ? "Why resume?" : "Why pause? (shown in the banner)"}>
              <input name="reason" required className="field" placeholder={paused.paused ? "Fixed the deploy issue" : "Investigating a bad deploy"} />
            </Field>
            {paused.paused ? <Submit intent="resume" primary>Resume the cycle</Submit> : <Submit intent="pause" primary>Pause everything</Submit>}
          </Form>
        </Panel>

        <Panel
          title="Run today's cycle now"
          description="Freezes the top idea and builds it immediately, if today's cycle hasn't run yet. The worker polls for this."
        >
          {pending.map((p) => (
            <Notice key={p.type} tone="jam" className="mb-3">
              Pending worker request:{" "}
              <strong>{p.type === "run_cycle" ? "run cycle" : `rollback to #${p.deploymentId}`}</strong> since{" "}
              {dateTime(p.requestedAt)}.
            </Notice>
          ))}
          <Form method="post">
            <CsrfInput />
            <Submit intent="run_cycle">Run today's cycle</Submit>
          </Form>
        </Panel>

        <Panel title="Ban or unban" description="Banning signs the user out everywhere and blocks posting, voting and commenting.">
          <Form method="post" className="space-y-3">
            <CsrfInput />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="GitHub login">
                <input name="login" required className="field" placeholder="octocat" autoComplete="off" />
              </Field>
              <Field label="Reason (public)">
                <input name="reason" required className="field" placeholder="Spam" />
              </Field>
            </div>
            <div className="flex gap-2">
              <Submit intent="ban" primary>
                Ban
              </Submit>
              <Submit intent="unban">Unban</Submit>
            </div>
          </Form>
        </Panel>

        <Panel
          title="Record a contribution"
          description="Money that went into oojam's Anthropic account: sponsors, maintainers. Shown publicly on /fund."
        >
          <Form method="post" className="space-y-3" key={`contribution-${actionKey}`}>
            <CsrfInput />
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Field label="Source (public)">
                <input name="source" required className="field" placeholder="GitHub Sponsors, October" autoComplete="off" />
              </Field>
              <Field label="Dollars">
                <input name="dollars" required inputMode="decimal" className="field num" placeholder="50.00" pattern="[0-9]+(\.[0-9]{1,2})?" />
              </Field>
            </div>
            <Field label="Note (optional, public)">
              <input name="note" className="field" placeholder="Thanks, @octocat!" />
            </Field>
            <Submit intent="contribution" primary>
              Record contribution
            </Submit>
          </Form>
        </Panel>

        <Panel title="Adjust the fund" description="Corrections either way, e.g. an Anthropic invoice that differs from the metered cost.">
          <Form method="post" className="space-y-3" key={`adjust-${actionKey}`}>
            <CsrfInput />
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Dollars (±)">
                <input name="dollars" required inputMode="decimal" className="field num" placeholder="-2.50" pattern="-?[0-9]+(\.[0-9]{1,2})?" />
              </Field>
              <Field label="Reason (public)">
                <input name="reason" required className="field" placeholder="October invoice reconciliation" />
              </Field>
            </div>
            <Submit intent="adjust_fund">Adjust fund</Submit>
          </Form>
        </Panel>
      </div>

      <Growth stats={growth} />

      <section className="mt-12">
        <h2 className="font-display text-xl font-black tracking-tight">Deployments</h2>
        <p className="mt-1 text-sm text-ink-2">
          Rolling back reconnects a retired container as the live site. Data is never touched (migrations are additive).
        </p>
        {deployments.length === 0 ? (
          <p className="mt-4 text-ink-3">No deployments yet.</p>
        ) : (
          <div className="card mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wider text-ink-3">
                  <th scope="col" className="px-4 py-3">#</th>
                  <th scope="col" className="px-4 py-3">Build</th>
                  <th scope="col" className="px-4 py-3">SHA</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Created</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {deployments.map((d) => (
                  <tr key={d.id}>
                    <td className="num px-4 py-3 text-ink-3">{d.id}</td>
                    <td className="max-w-[14rem] truncate px-4 py-3">
                      {d.buildId ? (
                        <a href={`/builds/${d.buildId}`} className="hover:underline">
                          {d.day ? day(d.day) : `#${d.buildId}`} · {d.ideaTitle ?? "—"}
                        </a>
                      ) : (
                        <span className="text-ink-3">manual</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{d.sha.slice(0, 12)}</td>
                    <td className="px-4 py-3">
                      <StatusChip status={d.status} />
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap text-ink-2">{dateTime(d.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {d.status === "retired" && live && (
                        <Form
                          method="post"
                          onSubmit={(e) => {
                            if (!confirm(`Roll back the live site to ${d.sha.slice(0, 12)}?`)) e.preventDefault();
                          }}
                        >
                          <CsrfInput />
                          <input type="hidden" name="deploymentId" value={d.id} />
                          <Submit intent="rollback">Roll back</Submit>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  native: "Share sheet",
  copy: "Copied link",
  x: "X",
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  hackernews: "Hacker News",
  email: "Email",
  embed: "Embed",
  other: "Other",
};

function Growth({ stats }: { stats: ViralStats[] }) {
  return (
    <section className="mt-12" aria-labelledby="growth-title">
      <h2 id="growth-title" className="font-display text-xl font-black tracking-tight">
        Growth
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Viral coefficient = new accounts that arrived through a share link ÷ accounts that voted in the window. Above 1,
        oojam grows on its own.
      </p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {stats.map((g) => {
          const channels = Object.entries(g.shares).sort((a, b) => b[1] - a[1]);
          const totalShares = channels.reduce((n, [, c]) => n + c, 0);
          const max = Math.max(1, ...channels.map(([, c]) => c));
          return (
            <div key={g.days} className="card p-5 sm:p-6">
              <div className="flex items-baseline justify-between gap-3">
                <p className="kicker">Last {g.days} days</p>
                <p className="text-right">
                  <span className="num font-display text-4xl font-black tracking-tight text-jam-ink">{g.kFactor.toFixed(2)}</span>
                  <span className="ml-1.5 text-xs font-semibold text-ink-3">viral coefficient</span>
                </p>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                {[
                  ["Shares", totalShares],
                  ["Ref visits", g.refVisits],
                  ["Sign-ups via ref", `${g.refSignups} / ${g.newUsers}`],
                  ["Votes via ref", g.refVotes],
                  ["Voters", g.voters],
                  ["New accounts", g.newUsers],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-sunk px-3 py-2">
                    <dt className="text-xs text-ink-3">{label}</dt>
                    <dd className="num font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
              <h3 className="mt-5 text-xs font-bold uppercase tracking-wider text-ink-3">Shares by channel</h3>
              {channels.length === 0 ? (
                <p className="mt-2 text-sm text-ink-3">No shares yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {channels.map(([ch, n]) => (
                    <li key={ch} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-sm">
                      <span className="truncate text-ink-2">{CHANNEL_LABELS[ch] ?? ch}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-sunk">
                        <span className="block h-full rounded-full bg-jam" style={{ width: `${(n / max) * 100}%` }} />
                      </span>
                      <span className="num text-right font-semibold">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
