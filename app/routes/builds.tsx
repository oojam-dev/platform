import { Link } from "react-router";

import { listBuilds } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { EmptyState, PageTitle, StatusChip } from "../components/ui";
import { day, money } from "../lib/format";
import type { Route } from "./+types/builds";

export const meta: Route.MetaFunction = () => [{ title: "Builds · oojam build" }];

export async function loader() {
  return { builds: await listBuilds(getDb(), 120) };
}

export default function Builds({ loaderData }: Route.ComponentProps) {
  const { builds } = loaderData;
  return (
    <>
      <PageTitle kicker="One a day" title="Builds">
        Every day at 00:00 UTC the top idea is frozen and handed to Claude in a throwaway container. Here's every
        attempt — what it cost, how it went, and the pull request it produced.
      </PageTitle>
      {builds.length === 0 ? (
        <EmptyState title="No builds yet.">The first one starts at the next 00:00 UTC with an idea on the board.</EmptyState>
      ) : (
        <ol className="card divide-y divide-line overflow-hidden">
          {builds.map((b) => (
            <li key={b.id}>
              <Link
                to={`/builds/${b.id}`}
                className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 px-4 py-4 hover:bg-sunk sm:grid-cols-[7rem_minmax(0,1fr)_auto_auto] sm:px-5"
              >
                <span className="num text-sm font-semibold text-ink-2">{day(b.day)}</span>
                <span className="min-w-0 truncate font-semibold">
                  {b.ideaTitle ?? <span className="text-ink-3 italic">No idea built</span>}
                </span>
                <span className="col-start-2 sm:col-start-auto">
                  <StatusChip status={b.status} />
                </span>
                <span className="num col-start-2 text-sm text-ink-2 sm:col-start-auto sm:w-36 sm:text-right">
                  {money(b.costCents)} <span className="text-ink-3">of {money(b.budgetCents)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
