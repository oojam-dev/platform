import { Link } from "react-router";

import { config } from "../../src/core/config.js";
import { fundSummary, listBuilds, listContributions } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { PageTitle, SponsorCard, Stat, StatusChip } from "../components/ui";
import { day, money, signedMoney } from "../lib/format";
import type { Route } from "./+types/fund";

export const meta: Route.MetaFunction = () => [{ title: "The fund · oojam build" }];

export async function loader() {
  const db = getDb();
  const [summary, builds, contributions] = await Promise.all([fundSummary(db), listBuilds(db, 365), listContributions(db, 100)]);
  return {
    summary,
    builds,
    contributions,
    capUsd: config.buildBudgetCapUsd,
    minUsd: config.buildBudgetMinUsd,
    sponsorUrl: config.sponsorUrl,
  };
}

export default function Fund({ loaderData }: Route.ComponentProps) {
  const { summary: s, builds, contributions, capUsd, minUsd, sponsorUrl } = loaderData;

  return (
    <>
      <PageTitle kicker="Open books" title="The build fund">
        Voting on oojam is free. The only thing that costs money is Claude doing the building, and that's paid from
        this fund: Anthropic credits donated by sponsors and the maintainers. Every dollar in and out is listed here.
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat accent label="Fund balance" value={money(s.balanceCents)} hint={`Pays for builds, up to ${money(capUsd * 100)} each`} />
        <Stat label="Total contributed" value={money(s.contributedCents)} hint="From sponsors and maintainers" />
        <Stat label="Spent on builds" value={money(s.buildSpendCents)} hint="Metered per token, per build" />
        <Stat label="Spent on screening" value={money(s.screeningCents)} hint="Claude checking new ideas" />
        <Stat
          label="Adjustments"
          value={s.adjustmentsCents === 0 ? money(0) : signedMoney(s.adjustmentsCents)}
          hint={
            <>
              Corrections, each with a reason on{" "}
              <Link to="/transparency" className="link">
                /transparency
              </Link>
            </>
          }
        />
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

          <div>
            <h2 className="font-display text-xl font-black tracking-tight">Contributions</h2>
            {contributions.length === 0 ? (
              <p className="mt-4 text-ink-2">
                None recorded yet.{" "}
                <a href={sponsorUrl} target="_blank" rel="noopener" className="link">
                  Be the first sponsor
                </a>
                .
              </p>
            ) : (
              <ol className="card mt-4 divide-y divide-line">
                {contributions.map((c) => (
                  <li key={c.id} className="flex items-start justify-between gap-4 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <p className="font-semibold [overflow-wrap:anywhere]">{c.source ?? "Anonymous"}</p>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {day(c.createdAt)}
                        {c.note ? ` · ${c.note}` : ""}
                      </p>
                    </div>
                    <span className="num shrink-0 font-semibold text-ok">+{money(c.cents)}</span>
                  </li>
                ))}
              </ol>
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
              Every build is capped at <strong className="text-ink">{money(capUsd * 100)}</strong> and skipped if the fund
              is below <strong className="text-ink">{money(minUsd * 100)}</strong>. A skipped idea stays on the board.
            </li>
            <li>Only what a build actually uses is taken from the fund; the rest rolls over to tomorrow.</li>
            <li>Screening each new idea costs a few cents, also paid from the fund.</li>
          </ul>
          <p className="mt-4">
            Contributions and adjustments are recorded by admins and also appear on the{" "}
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
