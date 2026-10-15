import { Link } from "react-router";

import { config } from "../../src/core/config.js";
import { costSummary, listBuilds } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { PageTitle, SponsorCard, Stat, StatusChip } from "../components/ui";
import { day, money } from "../lib/format";
import type { Route } from "./+types/costs";

export const meta: Route.MetaFunction = () => [{ title: "Costs · oojam build" }];

export async function loader() {
  const db = getDb();
  const [summary, builds] = await Promise.all([costSummary(db), listBuilds(db, 365)]);
  return {
    summary,
    builds,
    dailyUsd: config.dailyBudgetUsd,
    minUsd: config.buildBudgetMinUsd,
    sponsorUrl: config.sponsorUrl,
  };
}

export default function Costs({ loaderData }: Route.ComponentProps) {
  const { summary: s, builds, dailyUsd, minUsd, sponsorUrl } = loaderData;
  const leftToday = Math.max(0, s.dailyBudgetCents - s.todayCents);

  return (
    <>
      <PageTitle kicker="Open books" title="What oojam costs">
        Voting on oojam is free. The only thing that costs money is Claude: screening new ideas, building the winner
        and reviewing the result. oojam spends at most {money(dailyUsd * 100)} a day on it, and every cent is listed here.
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat accent label="Spent today" value={money(s.todayCents)} hint={`${money(leftToday)} of today's ${money(s.dailyBudgetCents)} left`} />
        <Stat label="This month" value={money(s.monthCents)} hint="Since the 1st, UTC" />
        <Stat label="All time" value={money(s.allTimeCents)} hint="Every build and screening since day zero" />
        <Stat label="Spent on builds" value={money(s.buildCents)} hint="Builder, review, metered per token" />
        <Stat label="Spent on screening" value={money(s.screeningCents)} hint="Claude checking new ideas" />
        <div className="sm:col-span-2 lg:col-span-1">
          <SponsorCard url={sponsorUrl} compact />
        </div>
      </div>

      <section className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-14">
          <div>
            <h2 className="font-display text-xl font-black tracking-tight">Cost per build</h2>
            {builds.length === 0 ? (
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
                    {builds.map((b) => (
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

        </div>

        <aside className="card self-start p-6 text-sm leading-relaxed text-ink-2">
          <h2 className="font-display text-lg font-black tracking-tight text-ink">How the money works</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <strong className="text-ink">Nobody pays to vote.</strong> Votes are free and sponsorship can't buy them.
            </li>
            <li>
              oojam spends at most <strong className="text-ink">{money(dailyUsd * 100)}</strong> on Claude per UTC day.
              The 00:00 build gets almost all of it; a little is kept back for screening new ideas.
            </li>
            <li>
              If less than <strong className="text-ink">{money(minUsd * 100)}</strong> is free for building, the day is
              skipped and the top idea waits for tomorrow.
            </li>
            <li>Spend is metered per token as Claude works, and a build is cut off the moment it hits its budget.</li>
            <li>
              Sponsoring pays the Anthropic bill that makes this possible.{" "}
              <a href={sponsorUrl} target="_blank" rel="noopener" className="link">
                Sponsor oojam
              </a>
              .
            </li>
          </ul>
        </aside>
      </section>
    </>
  );
}
