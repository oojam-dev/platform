import { Link, data } from "react-router";

import { getBuild } from "../../src/core/stats.js";
import { getDb } from "../../src/db/client.js";
import { BackLink, Markdown, Notice, StatusChip } from "../components/ui";
import { dateTime, day, money } from "../lib/format";
import { renderMarkdown } from "../lib/markdown.server";
import type { Route } from "./+types/builds.$id";

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Build ${data.build.day} · oojam build` : "Build · oojam build" },
];

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw data("No such build.", { status: 404 });
  const b = await getBuild(getDb(), id);
  if (!b) throw data("No such build.", { status: 404 });
  return {
    build: {
      id: b.id,
      day: b.day,
      status: b.status,
      attempt: b.attempt,
      budgetCents: b.budgetCents,
      costCents: b.costCents,
      prNumber: b.prNumber,
      prUrl: b.prUrl,
      mergeSha: b.mergeSha,
      error: b.error,
      log: b.log ?? [],
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      ideaId: b.ideaId,
      ideaTitle: b.ideaTitle,
    },
    summaryHtml: renderMarkdown(b.summary),
    gateHtml: renderMarkdown(b.gateReport),
  };
}

export default function BuildPage({ loaderData }: Route.ComponentProps) {
  const { build, summaryHtml, gateHtml } = loaderData;
  const pct = build.budgetCents > 0 ? Math.min(100, Math.round((build.costCents / build.budgetCents) * 100)) : 0;
  const over = build.budgetCents > 0 && build.costCents > build.budgetCents;

  return (
    <article>
      <BackLink to="/builds">All builds</BackLink>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusChip status={build.status} />
        <span className="text-sm text-ink-3">
          Build #{build.id} · {day(build.day)}
          {build.attempt > 0 && ` · attempt ${build.attempt}`}
        </span>
      </div>
      <h1 className="max-w-3xl font-display text-3xl font-black leading-[1.08] tracking-tight text-balance sm:text-[2.6rem]">
        {build.ideaTitle && build.ideaId ? (
          <Link to={`/ideas/${build.ideaId}`} className="hover:text-jam-ink">
            {build.ideaTitle}
          </Link>
        ) : (
          "No idea was built this day"
        )}
      </h1>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
        <div className="min-w-0 space-y-10">
          {build.error && (
            <Notice tone="warn" title={build.status === "skipped" ? "Skipped" : "What went wrong"}>
              <p className="whitespace-pre-wrap">{build.error}</p>
            </Notice>
          )}

          {summaryHtml && (
            <section aria-labelledby="summary-title">
              <h2 id="summary-title" className="kicker mb-3">
                Builder's summary
              </h2>
              <Markdown html={summaryHtml} />
            </section>
          )}

          {gateHtml && (
            <details className="card group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between font-bold">
                Gate report
                <span aria-hidden="true" className="text-ink-3 transition-transform group-open:rotate-180">
                  ▾
                </span>
              </summary>
              <p className="mt-1 text-sm text-ink-3">What the host-side guardrails and the independent review found.</p>
              <Markdown html={gateHtml} className="mt-4 text-sm" />
            </details>
          )}

          <section aria-labelledby="timeline-title">
            <h2 id="timeline-title" className="kicker mb-4">
              Timeline
            </h2>
            {build.log.length === 0 ? (
              <p className="text-ink-3">Nothing logged yet.</p>
            ) : (
              <ol className="relative space-y-5 border-l-2 border-line pl-6">
                {build.log.map((e, i) => (
                  <li key={i} className="relative">
                    <span
                      aria-hidden="true"
                      className={`absolute top-1.5 -left-[1.95rem] size-3 rounded-full border-2 border-paper ${
                        i === build.log.length - 1 ? "bg-jam" : "bg-line-strong"
                      }`}
                    />
                    <p className="text-sm">
                      <span className="font-bold">{e.step}</span>
                      <span className="num ml-2 text-xs text-ink-3">{dateTime(e.at)}</span>
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {e.message}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="space-y-4">
          <div className="card p-5">
            <p className="kicker">Cost vs budget</p>
            <p className="num mt-2 font-display text-3xl font-black tracking-tight">{money(build.costCents)}</p>
            <p className="text-sm text-ink-2">of a {money(build.budgetCents)} budget</p>
            <div
              className="mt-4 h-2.5 overflow-hidden rounded-full bg-sunk"
              role="meter"
              aria-label="Budget used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className={`h-full rounded-full ${over ? "bg-warn" : "bg-jam"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-ink-3">Counts towards the day's budget. Metered per token by the gateway.</p>
          </div>
          <dl className="card divide-y divide-line text-sm">
            {build.prUrl && (
              <div className="flex justify-between gap-3 p-4">
                <dt className="text-ink-3">Pull request</dt>
                <dd>
                  <a href={build.prUrl} className="link font-semibold" rel="noopener">
                    #{build.prNumber ?? "PR"} on GitHub
                  </a>
                </dd>
              </div>
            )}
            {build.mergeSha && (
              <div className="flex justify-between gap-3 p-4">
                <dt className="text-ink-3">Merged</dt>
                <dd>
                  <a href={`https://github.com/oojam-dev/oojam/commit/${build.mergeSha}`} className="link font-mono" rel="noopener">
                    {build.mergeSha.slice(0, 7)}
                  </a>
                </dd>
              </div>
            )}
            {build.startedAt && (
              <div className="flex justify-between gap-3 p-4">
                <dt className="text-ink-3">Started</dt>
                <dd className="num text-right">{dateTime(build.startedAt)}</dd>
              </div>
            )}
            {build.finishedAt && (
              <div className="flex justify-between gap-3 p-4">
                <dt className="text-ink-3">Finished</dt>
                <dd className="num text-right">{dateTime(build.finishedAt)}</dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </article>
  );
}
