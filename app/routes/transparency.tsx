import { Link } from "react-router";

import { listAudit } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { EmptyState, PageTitle } from "../components/ui";
import { dateTime, signedMoney } from "../lib/format";
import { ideaTitles, loginsByIds } from "../lib/queries.server";
import type { Route } from "./+types/transparency";

export const meta: Route.MetaFunction = () => [{ title: "Transparency · oojam build" }];

function parseSubject(subject: string): { kind: string; id: number | null } {
  const [kind = subject, raw] = subject.split(":");
  const id = Number(raw);
  return { kind, id: Number.isSafeInteger(id) ? id : null };
}

export async function loader() {
  const db = getDb();
  const entries = await listAudit(db, 300);
  const subjects = entries.map((e) => parseSubject(e.subject));
  const [titles, logins] = await Promise.all([
    ideaTitles(db, subjects.filter((s) => s.kind === "idea" && s.id).map((s) => s.id!)),
    loginsByIds(db, subjects.filter((s) => s.kind === "user" && s.id).map((s) => s.id!)),
  ]);
  return { entries, titles, logins };
}

const ACTIONS: Record<string, string> = {
  pause: "Paused the daily cycle",
  resume: "Resumed the daily cycle",
  hide_idea: "Hid an idea",
  reject_idea: "Rejected an idea",
  hide_comment: "Hid a comment",
  ban_user: "Banned a user",
  unban_user: "Unbanned a user",
  adjust_wallet: "Adjusted a wallet",
  request_run_cycle: "Asked the worker to run today's cycle now",
  request_rollback: "Asked the worker to roll back a deployment",
  screen_reject: "Screening rejected an idea",
  dispute: "A card payment was disputed",
};

export default function Transparency({ loaderData }: Route.ComponentProps) {
  const { entries, titles, logins } = loaderData;
  return (
    <>
      <PageTitle kicker="Public audit log" title="Transparency">
        Every moderation decision, admin action, wallet adjustment and automated rejection is recorded here, with its
        reason. Nothing is deleted.
      </PageTitle>
      {entries.length === 0 ? (
        <EmptyState title="Nothing to report.">No admin or automated actions have been taken yet.</EmptyState>
      ) : (
        <ol className="card divide-y divide-line">
          {entries.map((e) => {
            const subj = parseSubject(e.subject);
            const data = (e.data ?? {}) as Record<string, unknown>;
            const reason = typeof data.reason === "string" ? data.reason : null;
            const cents = typeof data.cents === "number" ? data.cents : null;
            const category = typeof data.category === "string" ? data.category : null;
            const deploymentId = typeof data.deploymentId === "number" ? data.deploymentId : null;
            return (
              <li key={e.id} className="grid gap-1 px-4 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6 sm:px-5">
                <time dateTime={new Date(e.createdAt).toISOString()} className="num pt-0.5 text-xs text-ink-3">
                  {dateTime(e.createdAt)}
                </time>
                <div className="min-w-0">
                  <p className="font-semibold">
                    {ACTIONS[e.action] ?? e.action}
                    {subj.kind === "idea" && subj.id ? (
                      <>
                        {": "}
                        <Link to={`/ideas/${subj.id}`} className="link font-normal">
                          {titles[subj.id] ?? `idea #${subj.id}`}
                        </Link>
                      </>
                    ) : subj.kind === "user" && subj.id ? (
                      <span className="font-normal">: @{logins[subj.id] ?? `user #${subj.id}`}</span>
                    ) : subj.kind === "comment" && subj.id ? (
                      <span className="font-normal text-ink-2"> (comment #{subj.id})</span>
                    ) : null}
                    {cents != null && <span className="num ml-1 font-normal">({signedMoney(cents)})</span>}
                    {deploymentId != null && <span className="font-normal text-ink-2"> (deployment #{deploymentId})</span>}
                  </p>
                  {reason && <p className="mt-0.5 text-sm text-ink-2">“{reason}”</p>}
                  {category && <p className="mt-0.5 font-mono text-xs text-ink-3">rule: {category}</p>}
                  <p className="mt-1 text-xs text-ink-3">by {e.actor ? `@${e.actor}` : "the system"}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
