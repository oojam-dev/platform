import type { ReactNode } from "react";
import { Form, data, useNavigation } from "react-router";

import { adminAdjustWallet, banUser, requestWorker, unbanUser } from "../../src/core/admin.js";
import { getPaused, setPaused } from "../../src/core/controls.js";
import { LedgerError } from "../../src/core/ledger.js";
import { getDb } from "../../src/db/client.js";
import { CsrfInput, Notice, PageTitle, StatusChip } from "../components/ui";
import { dateTime, day, signedMoney } from "../lib/format";
import { pendingWorkerRequest, recentDeployments, userByLogin } from "../lib/queries.server";
import { requireAdmin, requireMutation } from "../lib/session.server";
import type { Route } from "./+types/admin";

export const meta: Route.MetaFunction = () => [{ title: "Admin · oojam build" }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const db = getDb();
  const [paused, deployments, pending] = await Promise.all([getPaused(db), recentDeployments(db, 20), pendingWorkerRequest(db)]);
  return { paused, deployments, pending };
}

type Result = { ok: boolean; intent: string; message: string };

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
    if (!u) throw new LedgerError("not_found", `No oojam user with GitHub login “${login.trim()}”.`);
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
      case "adjust": {
        const u = await target();
        const dollars = Number(String(form.get("dollars") ?? "").trim());
        const cents = Math.round(dollars * 100);
        if (!Number.isFinite(dollars) || cents === 0 || Math.abs(cents) > 100_000) {
          return fail("Enter a non-zero dollar amount up to ±$1,000 (e.g. 5 or -2.50).");
        }
        await adminAdjustWallet(db, user.id, u.id, cents, reason);
        return ok(`Adjusted @${u.githubLogin}'s wallet by ${signedMoney(cents)}.`);
      }
      default:
        return fail("Unknown action.");
    }
  } catch (error) {
    if (error instanceof LedgerError) return fail(error.message);
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
  const { paused, deployments, pending } = loaderData;
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
          {pending && (
            <Notice tone="jam" className="mb-3">
              Pending worker request: <strong>{pending.type === "run_cycle" ? "run cycle" : `rollback to #${pending.deploymentId}`}</strong>{" "}
              since {dateTime(pending.requestedAt)}.
            </Notice>
          )}
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

        <Panel title="Adjust a wallet" description="Positive to credit, negative to debit. Use for goodwill refunds and corrections.">
          <Form method="post" className="space-y-3">
            <CsrfInput />
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <Field label="GitHub login">
                <input name="login" required className="field" placeholder="octocat" autoComplete="off" />
              </Field>
              <Field label="Dollars">
                <input name="dollars" required inputMode="decimal" className="field num" placeholder="5.00" pattern="-?[0-9]+(\.[0-9]{1,2})?" />
              </Field>
            </div>
            <Field label="Reason (public)">
              <input name="reason" required className="field" placeholder="Refund for a double charge" />
            </Field>
            <Submit intent="adjust" primary>
              Adjust wallet
            </Submit>
          </Form>
        </Panel>
      </div>

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
