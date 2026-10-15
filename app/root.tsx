import type { ReactNode } from "react";
import {
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
} from "react-router";

import { config } from "../src/core/config.js";
import { getPaused } from "../src/core/controls.js";
import { budgetLeftTodayCents, dailyBudgetCents } from "../src/core/spend.js";
import { nextFreeze } from "../src/core/time.js";
import { getDb } from "../src/db/client.js";
import type { Route } from "./+types/root";
import "./app.css";
import { Countdown } from "./components/countdown";
import { ErrorPage } from "./components/error-page";
import { Avatar, HeartIcon, Wordmark } from "./components/ui";
import { money } from "./lib/format";
import { useRootData } from "./lib/root-data";
import { csrfToken, optionalUser } from "./lib/session.server";

export const meta: Route.MetaFunction = () => [
  { title: "oojam build — the community decides what oojam.dev becomes" },
  {
    name: "description",
    content:
      "Vote for the ideas you like, free. Every day at 00:00 UTC the top idea is built by Claude and deployed to oojam.dev. Just a bit of fun.",
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const db = getDb();
  const user = await optionalUser(request);
  const [leftTodayCents, paused] = await Promise.all([budgetLeftTodayCents(db), getPaused(db)]);
  return {
    user: user
      ? {
          id: user.id,
          login: user.githubLogin,
          name: user.name,
          avatarUrl: user.avatarUrl,
          isAdmin: user.isAdmin,
          bannedAt: user.bannedAt,
          bannedReason: user.bannedReason,
        }
      : null,
    csrf: csrfToken(user),
    spentTodayCents: dailyBudgetCents() - leftTodayCents,
    dailyBudgetCents: dailyBudgetCents(),
    siteUrl: config.siteUrl.replace(/\/$/, ""),
    nextFreezeAt: nextFreeze().toISOString(),
    serverNow: Date.now(),
    paused,
    sponsorUrl: config.sponsorUrl,
    platformUrl: config.platformUrl.replace(/\/$/, ""),
    rules: {
      maxIdeasPerDay: config.maxIdeasPerDay,
      dailyBudgetUsd: config.dailyBudgetUsd,
      budgetMinUsd: config.buildBudgetMinUsd,
    },
  };
}

const NAV = [
  { to: "/", label: "Ideas", end: true },
  { to: "/builds", label: "Builds" },
  { to: "/costs", label: "Costs" },
  { to: "/rules", label: "Rules" },
];

function Header() {
  const root = useRootData();
  const location = useLocation();
  const user = root?.user;
  const returnTo = location.pathname + location.search;
  const nav = user?.isAdmin ? [...NAV, { to: "/admin", label: "Admin" }] : NAV;

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-5">
        <div className="flex items-baseline gap-2">
          {/* The wordmark goes to the site itself; the "build" pill is this app's home. */}
          <a href={root?.siteUrl ?? "https://oojam.dev"} className="rounded-lg" aria-label="oojam.dev">
            <Wordmark className="text-[2rem] sm:text-[2.35rem]" />
          </a>
          <Link
            to="/"
            className="rounded-full border border-line-strong px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wider text-ink-2 hover:border-ink"
            aria-label="oojam build, home"
          >
            build
          </Link>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {root && (
            <a
              href={root.sponsorUrl}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1.5 text-sm font-semibold text-ink-2 hover:text-jam-ink"
              title="Sponsor oojam: pays for builds, never buys votes"
            >
              <HeartIcon />
              <span className="sr-only sm:not-sr-only">Sponsor</span>
              <span className="sr-only sm:hidden">Sponsor oojam</span>
            </a>
          )}
          {user ? (
            <Link
              to="/account"
              className="inline-flex items-center gap-2 rounded-full border border-line-strong py-1 pr-1 pl-3 text-sm font-semibold hover:border-ink"
              title="Your account"
            >
              <span className="max-w-[9rem] truncate">
                <span className="sr-only">Your account, signed in as </span>@{user.login}
              </span>
              <Avatar src={user.avatarUrl} login={user.login} size={28} />
            </Link>
          ) : (
            <Link to={`/auth/github?return=${encodeURIComponent(returnTo)}`} className="btn btn-jam btn-sm">
              <GithubIcon />
              <span>
                Sign in<span className="hidden sm:inline"> with GitHub</span>
              </span>
            </Link>
          )}
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 pb-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <nav aria-label="Main" className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `rounded-full px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${
                  isActive || (n.to === "/" && location.pathname.startsWith("/ideas/"))
                    ? "bg-ink text-paper"
                    : "text-ink-2 hover:bg-sunk hover:text-ink"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        {root && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
            <Link to="/costs" className="inline-flex items-center gap-1.5 hover:underline" title="oojam spends at most this much on Claude per UTC day">
              <span aria-hidden="true" className="size-2 rounded-full bg-jam" />
              <span className="num font-semibold">{money(root.spentTodayCents)}</span>
              <span className="text-ink-3">of {money(root.dailyBudgetCents)} spent today</span>
            </Link>
            <Countdown target={root.nextFreezeAt} serverNow={root.serverNow} paused={root.paused.paused} />
          </div>
        )}
      </div>
    </header>
  );
}

function GithubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Banners() {
  const root = useRootData();
  if (!root) return null;
  return (
    <>
      {root.paused.paused && (
        <div role="status" className="bg-ink text-paper">
          <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-3 text-sm sm:px-6">
            <span aria-hidden="true" className="mt-0.5 inline-flex gap-0.5">
              <span className="h-3.5 w-1 rounded-sm bg-jam" />
              <span className="h-3.5 w-1 rounded-sm bg-jam" />
            </span>
            <p>
              <strong className="font-bold">The daily cycle is paused.</strong> No ideas will be frozen, built, merged or
              deployed until it resumes. Voting stays open.
              {root.paused.reason && <span className="opacity-80"> Reason: {root.paused.reason}</span>}
            </p>
          </div>
        </div>
      )}
      {root.user?.bannedAt && (
        <div role="alert" className="bg-warn-soft text-warn">
          <div className="mx-auto max-w-6xl px-4 py-3 text-sm sm:px-6">
            <strong>Your account is suspended.</strong> {root.user.bannedReason ?? ""} You can still read everything, but
            can't post, vote or comment. See <Link to="/transparency" className="underline">/transparency</Link>.
          </div>
        </div>
      )}
    </>
  );
}

function Footer() {
  const root = useRootData();
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-[1.4fr_1fr_1fr] sm:px-6">
        <div>
          <a href={root?.siteUrl ?? "https://oojam.dev"} aria-label="oojam.dev">
            <Wordmark className="text-2xl" />
          </a>
          <p className="mt-2 max-w-xs text-ink-2">
            A website with no designated purpose. The community decides what it becomes, one vote and one day at a
            time. Just a bit of fun.
          </p>
        </div>
        <ul className="space-y-2">
          <li>
            <a className="link" href="https://oojam.dev">
              oojam.dev
            </a>
            <span className="text-ink-3"> — the site being built</span>
          </li>
          <li>
            <Link className="link" to="/transparency">
              Transparency log
            </Link>
          </li>
          <li>
            <Link className="link" to="/rules">
              Rules &amp; content policy
            </Link>
          </li>
        </ul>
        <ul className="space-y-2">
          <li>
            <a className="link" href="https://github.com/oojam-dev/oojam" rel="noopener">
              github.com/oojam-dev/oojam
            </a>
          </li>
          <li>
            <a className="link" href="https://github.com/oojam-dev/platform" rel="noopener">
              github.com/oojam-dev/platform
            </a>
          </li>
          {root && (
            <li>
              <a className="link inline-flex items-center gap-1" href={root.sponsorUrl} target="_blank" rel="noopener">
                <HeartIcon /> Sponsor oojam
              </a>
              <span className="text-ink-3"> — pays for builds, never buys votes</span>
            </li>
          )}
          <li className="text-ink-3">Everything is open source · MIT</li>
        </ul>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  // /embed/* is framed by other sites: no chrome, transparent background.
  const embed = useLocation().pathname.startsWith("/embed/");
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#faf6f0" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#141110" media="(prefers-color-scheme: dark)" />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='10' cy='16' r='8' fill='%23c40e4f'/%3E%3Ccircle cx='22' cy='16' r='8' fill='%23c40e4f' fill-opacity='.6'/%3E%3C/svg%3E"
        />
        <Meta />
        <Links />
      </head>
      {embed ? (
        <body className="bg-transparent! p-0">
          {children}
          <Scripts />
        </body>
      ) : (
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
        >
          Skip to content
        </a>
        <Banners />
        <Header />
        <main id="main" className="mx-auto max-w-6xl px-4 pt-10 sm:px-6 sm:pt-14">
          {children}
        </main>
        <Footer />
        <ScrollRestoration />
        <Scripts />
      </body>
      )}
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let code = "Oops";
  let title = "Something went sideways.";
  let detail: string | undefined = "An unexpected error happened. It's been logged; try again in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    code = String(error.status);
    if (error.status === 404) {
      title = "Nothing here (yet).";
      detail = "That page doesn't exist. Maybe it's an idea?";
    } else if (error.status === 403) {
      title = "Not allowed.";
      detail = typeof error.data === "string" ? error.data : "You don't have permission to do that.";
    } else {
      title = error.statusText || title;
      detail = typeof error.data === "string" ? error.data : detail;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  return <ErrorPage code={code} title={title} detail={detail} stack={stack} />;
}
