import type { ReactNode } from "react";
import { Link } from "react-router";

import { config } from "../../src/core/config.js";
import { POLICY_RULES } from "../../src/core/policy.js";
import { PageTitle } from "../components/ui";
import { money } from "../lib/format";
import type { Route } from "./+types/rules";

export const meta: Route.MetaFunction = () => [{ title: "Rules · oojam build" }];

export async function loader() {
  return {
    rules: POLICY_RULES,
    maxVotes: config.maxVotesPerUserPerIdea,
    share: config.buildFundShare,
    capUsd: config.buildBudgetCapUsd,
    minUsd: config.buildBudgetMinUsd,
    minAccountAge: config.minGithubAccountAgeDays,
  };
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 border-t border-line pt-10">
      <h2 id={`${id}-title`} className="font-display text-2xl font-black tracking-tight">
        {title}
      </h2>
      <div className="mt-4 space-y-4 leading-relaxed text-ink-2 [&_strong]:text-ink">{children}</div>
    </section>
  );
}

export default function Rules({ loaderData }: Route.ComponentProps) {
  const { rules, maxVotes, share, capUsd, minUsd, minAccountAge } = loaderData;
  const pct = Math.round(share * 100);
  const toc = [
    ["voting", "Ideas & voting"],
    ["money", "Money & refunds"],
    ["policy", "Content policy"],
    ["guardrails", "Guardrails"],
    ["open", "Open source"],
  ];

  return (
    <div className="grid gap-10 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-16">
      <nav aria-label="On this page" className="hidden lg:block">
        <ul className="sticky top-6 space-y-2 text-sm">
          {toc.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="font-medium text-ink-2 hover:text-jam-ink">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="max-w-2xl space-y-12">
        <PageTitle kicker="The rules" title="How oojam works, and what it won't do">
          oojam.dev has no designated purpose. You decide what it becomes — within a few rules that keep it fair, legal
          and safe to run in public.
        </PageTitle>

        <Section id="voting" title="Ideas & voting">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Posting an idea costs $1</strong>, which also casts your first vote for it. Titles are 8–120
              characters; descriptions up to 4,000 characters of Markdown.
            </li>
            <li>
              <strong>Each vote costs $1.</strong> You can put at most <strong>{maxVotes} votes</strong> on any one idea.
              Votes can't be withdrawn.
            </li>
            <li>
              Ideas stay on the board until they're built. The board ranks by votes; ties go to the older idea.
            </li>
            <li>
              <strong>Every day at 00:00 UTC</strong>, the top idea is frozen and built by Claude. If it passes the
              guardrails and the repo's own checks, it's merged and deployed to oojam.dev automatically — no human in
              the loop.
            </li>
            <li>
              Signing in uses GitHub. Accounts must be at least {minAccountAge} days old. Comments are free for anyone
              who has topped up at least once.
            </li>
          </ul>
        </Section>

        <Section id="money" title="Money & refunds">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Top up your wallet with Stripe ($5, $10, $25 or any whole amount from $5 to $500). <strong>1 credit = $1.</strong>
            </li>
            <li>
              When you post or vote, that dollar is <strong>committed</strong>: {pct}% goes to the build fund and{" "}
              {100 - pct}% to hosting. See it all on{" "}
              <Link to="/fund" className="link">
                /fund
              </Link>
              .
            </li>
            <li>
              <strong>Committed credits are non-refundable.</strong> The one exception: if screening rejects your idea when
              you post it, the $1 goes straight back to your wallet.
            </li>
            <li>
              An idea that was voted to the top but is rejected at the pre-build screen isn't refunded — it was the
              community's choice, and the runner-up is built instead.
            </li>
            <li>Uncommitted credit never expires. It isn't refundable as cash, except at an admin's discretion (logged publicly).</li>
            <li>
              <strong>Disputing a card payment freezes the account</strong> pending review, and any unspent credit is
              frozen with it.
            </li>
            <li>
              Each build's budget is the fund balance capped at {money(capUsd * 100)}. Below {money(minUsd * 100)} the day is
              skipped.
            </li>
          </ul>
        </Section>

        <Section id="policy" title="Content policy">
          <p>
            Every idea is screened by Claude when it's posted, again just before it's built, and the finished code is
            reviewed against the same rules. An idea is out if it breaks any of these:
          </p>
          <ol className="space-y-3">
            {rules.map((r, i) => (
              <li key={r.id} className="card flex gap-4 p-4">
                <span className="num font-display text-xl font-black text-jam">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="text-ink">{r.rule}</p>
                  <p className="mt-1 font-mono text-xs text-ink-3">{r.id}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="guardrails" title="Guardrails">
          <p>
            The builder only ever sees a fresh copy of the site's repository. It can't see or change this platform —
            voting, payments and the guardrails live in a separate repo it never touches. Its output is judged from the
            outside:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Protected files.</strong> CI config, the licence, the Dockerfile, the site's CLAUDE.md, existing
              migrations and the health check can't be changed.
            </li>
            <li>
              <strong>Additive-only database migrations.</strong> New tables, columns and indexes are fine; dropping,
              truncating, renaming or rewriting existing data is blocked, and the database itself refuses mass deletes.
            </li>
            <li>
              <strong>Locked-down network.</strong> Builds run in a throwaway container that can reach only the model
              API (through a metering proxy) and the npm registry. New dependencies must be pinned, at least two weeks
              old and free of install scripts.
            </li>
            <li>
              <strong>Edge-enforced security headers.</strong> A strict Content-Security-Policy is applied in front of
              the site, so no build can add third-party scripts, trackers or outbound calls.
            </li>
            <li>
              <strong>Independent security review.</strong> A separate Claude run reviews every diff for security,
              policy and scope before it can merge.
            </li>
            <li>
              <strong>Smoke tests and auto-rollback.</strong> Each build is started against a copy of real data and
              clicked through first. If the live deploy fails its health check, it's rolled back automatically and the
              merge reverted.
            </li>
            <li>Admins can pause the whole cycle at any time. Every admin action is public.</li>
          </ul>
        </Section>

        <Section id="open" title="Everything is open source">
          <p>
            Both the site and this platform are MIT-licensed and public:{" "}
            <a href="https://github.com/oojam-dev/oojam" className="link">
              oojam-dev/oojam
            </a>{" "}
            and{" "}
            <a href="https://github.com/oojam-dev/platform" className="link">
              oojam-dev/platform
            </a>
            . Every build is a pull request you can read. Every admin action is on{" "}
            <Link to="/transparency" className="link">
              /transparency
            </Link>
            , and every dollar on{" "}
            <Link to="/fund" className="link">
              /fund
            </Link>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}
