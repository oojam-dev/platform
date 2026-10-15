import { Link } from "react-router";

import { config } from "../../src/core/config.js";
import { fundSummary, listBuilds } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { PageTitle, Stat, StatusChip } from "../components/ui";
import { day, money } from "../lib/format";
import type { Route } from "./+types/fund";

export const meta: Route.MetaFunction = () => [{ title: "The fund · oojam build" }];

export async function loader() {
  const db = getDb();
  const [summary, builds] = await Promise.all([fundSummary(db), listBuilds(db, 365)]);
  return {
    summary,
    builds,
    share: config.buildFundShare,
    capUsd: config.buildBudgetCapUsd,
    minUsd: config.buildBudgetMinUsd,
  };
}

export default function Fund({ loaderData }: Route.ComponentProps) {
  const { summary: s, builds, share, capUsd, minUsd } = loaderData;
  const buildPct = Math.round(share * 100);
  const spentBuilds = builds;

  return (
    <>
      <PageTitle kicker="Open books" title="Where the money goes">
        Every dollar committed on oojam is split the moment it's spent: <strong className="text-ink">{buildPct}%</strong>{" "}
        into the build fund, which pays Anthropic for the daily build, and{" "}
        <strong className="text-ink">{100 - buildPct}%</strong> to hosting, which covers the server, Stripe's fees,
        backups and screening. Nobody takes a cut.
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat accent label="Build fund balance" value={money(s.buildBalanceCents)} hint={`Pays for builds, up to ${money(capUsd * 100)} each`} />
        <Stat label="Total committed" value={money(s.committedCents)} hint="Every post and vote, ever" />
        <Stat label="Spent on builds" value={money(s.buildSpendCents)} hint="Metered per token, per build" />
        <Stat label="Hosting balance" value={money(s.hostingBalanceCents)} hint="After screening costs" />
        <Stat label="Spent on screening" value={money(s.screeningCents)} hint="Claude checking new ideas" />
        <Stat label="Unspent wallet credit" value={money(s.walletsOutstandingCents)} hint="Topped up, not yet committed" />
      </div>

      <section className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-black tracking-tight">Cost per build</h2>
          {spentBuilds.length === 0 ? (
            <p className="mt-4 text-ink-2">No builds yet.</p>
          ) : (
            <div className="card mt-4 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">Every build, its budget and what it actually cost</caption>
                <thead>
                  <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wider text-ink-3">
                    <th scope="col" className="px-4 py-3">Day</th>
                    <th scope="col" className="px-4 py-3">Idea</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3 text-right">Budget</th>
                    <th scope="col" className="px-4 py-3 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {spentBuilds.map((b) => (
                    <tr key={b.id}>
                      <td className="num px-4 py-3 whitespace-nowrap text-ink-2">
                        <Link to={`/builds/${b.id}`} className="hover:underline">
                          {day(b.day)}
                        </Link>
                      </td>
                      <td className="max-w-[16rem] truncate px-4 py-3 font-medium">
                        {b.ideaId ? (
                          <Link to={`/ideas/${b.ideaId}`} className="hover:underline">
                            {b.ideaTitle}
                          </Link>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip status={b.status} />
                      </td>
                      <td className="num px-4 py-3 text-right text-ink-2">{money(b.budgetCents)}</td>
                      <td className="num px-4 py-3 text-right font-semibold">{money(b.costCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <aside className="card self-start p-6 text-sm leading-relaxed text-ink-2">
          <h2 className="font-display text-lg font-black tracking-tight text-ink">How a build is budgeted</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              Each day's budget is the fund balance, capped at <strong className="text-ink">{money(capUsd * 100)}</strong>.
            </li>
            <li>
              Below <strong className="text-ink">{money(minUsd * 100)}</strong>, the day is skipped and the idea goes back on
              the board.
            </li>
            <li>Only what the build actually uses is taken from the fund; the rest rolls over.</li>
            <li>Screening a new idea is paid from hosting, so a rejected idea's refund is always the full $1.</li>
          </ul>
          <p className="mt-4">
            Admin adjustments and every other action are on the{" "}
            <Link to="/transparency" className="link">
              transparency log
            </Link>
            .
          </p>
        </aside>
      </section>
    </>
  );
}
