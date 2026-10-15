# oojam — specification

oojam.dev is a website with no designated purpose. The community decides what it becomes:
people commit dollars to post and upvote ideas, and every 24 hours the top idea is frozen
and built by Claude, merged as a pull request into the open-source `oojam` repository, and
deployed.

This file is the design **and** the contract between the parts. If code and this file
disagree, fix one of them in the same change.

---

## 1. The two repositories

| Repo | Licence | What | Who changes it |
|---|---|---|---|
| `oojam-dev/oojam` (local: `../site`) | MIT | **The site**: oojam.dev. React Router v7, Tailwind v4, Drizzle, Postgres. | The **builder**, once a day, through guarded PRs. Maintainers in emergencies. |
| `oojam-dev/platform` (this repo) | MIT | **The machine**: build.oojam.dev (accounts, ideas, votes, sharing, the daily spend cap), the daily cycle, the builder, guardrails, deploy, infra. | Maintainers only. **The builder never sees or touches it.** |

The wall between them is the most important property of the system. If the builder
could change voting or the guardrails, the community could vote its way past them
("give user X unlimited votes"). So:

- The builder only ever receives a fresh clone of `oojam-dev/oojam`.
- Guardrails, the orchestrator and the deploy logic live here, run on the host, and judge
  the builder's output from the outside.
- The site has no credentials for, and no network route to, the platform's database.

---

## 2. Product rules

### 2.1 Votes and money

oojam takes **no payments**: it's a bit of fun, not a business.
- Voting is free and tied to your GitHub account: **one vote per account per idea**, on as many
  ideas as you like, and voters are public.
- Claude is the only real cost. oojam spends at most **`DAILY_BUDGET_USD` ($10) per UTC day**, across
  the build, its review and idea screening.
  - Spend is metered per token by the gateway and recorded as append-only entries (`fund_entries`,
    kinds `build_spend`, `screening` and `adjustment`).
  - The 00:00 build gets the day's budget minus a 50¢ screening reserve.
  - If less than `BUILD_BUDGET_MIN_USD` ($3) is free, the day is skipped and the idea waits.
  - When the day's budget is spent, screening waits until 00:00 UTC.
- The Anthropic workspace spend limit is the hard ceiling outside oojam.
- Sponsorship goes through GitHub Sponsors (`SPONSOR_URL`) and **never buys votes**.
- Everything is public on `/costs`: today, this month, all time, and the cost of each build.

### 2.2 Ideas, votes and sharing

- **Posting** an idea is the author's vote for it. Each account may post **`MAX_IDEAS_PER_DAY` (1)**
  idea per UTC day, and make at most 3 attempts, counting ideas rejected at screening. Title:
  8–120 chars. Body: 0–4,000 chars of Markdown, rendered safely (no raw HTML).
- **Voting**: one vote per GitHub account per idea. A vote can be taken back while the idea is
  open. Every idea page shows who voted.
- **Ranking**: ideas stay on the board until they're built. The board sorts by
  `vote_count DESC, created_at ASC`, so ties go to the older idea. "New" sorts by `created_at DESC`.
- Ideas are **screened** by Claude at posting time against the content policy (§2.4). A rejection
  shows the reason and doesn't count towards the daily post limit.
- **Sharing is the growth loop.** Getting an idea built means getting people to vote for it.
  - Every idea has a share menu: the native share sheet, copy link, X, Bluesky, LinkedIn,
    Reddit, Hacker News and email.
  - Shared links carry `?ref=<github login>`. That records the visit, who referred a new account
    (`users.referred_by`), and whose share each vote came through (`votes.referrer_id`).
  - Idea pages show which shares brought voters. `/admin` shows shares by channel, referred
    visits, sign-ups and votes, and the viral coefficient (sign-ups that came through a share,
    per voter active in the window).
  - Each idea has an Open Graph image, Twitter card tags, an oEmbed endpoint and a frameable
    embed card, so a shared link previews well everywhere.
- **Comments**: any signed-in, unbanned account can comment (flat thread, 2,000 chars,
  rate-limited).
- **Fake accounts** are kept out by GitHub sign-in with a minimum account age, plus admin bans.

### 2.3 The daily cycle (00:00 UTC)

1. **Freeze.** The top `open` idea becomes `frozen` and its votes are locked. If there's no
   eligible idea, it's a **housekeeping day**: the builder makes one small, safe improvement (a
   bug, accessibility, phone layout, performance or tests; no new features and nothing removed)
   through the same gates and budget. It's credited to `@oojam-dev` and shown as "Housekeeping" in
   the changelog (`ideaId: null`).
2. **Budget check.** The build budget is what's left of today's `DAILY_BUDGET_USD` ($10), minus a
   50¢ screening reserve. If that's below `BUILD_BUDGET_MIN_USD` ($3), the day is `skipped`, the idea
   goes back to `open`, and the board shows why.
3. **Pre-build screen.** Claude screens the idea again with today's site in view. If it's
   now out of policy, the idea is `rejected` (votes aren't returned, because it was voted through) and
   the runner-up is frozen instead, up to 3 times.
4. **Build.** The builder runs in a throwaway container (§4) for up to 2 attempts. The second
   attempt gets the first attempt's gate report as feedback.
5. **Gate.** Host-side guardrails (§5). Any blocking finding fails the attempt.
6. **PR.** The branch is pushed and a PR opened on `oojam-dev/oojam` by the oojam GitHub App:
   - the title is the idea's title;
   - the body has the idea, the build summary, the gate report and the cost;
   - the commit carries a `Co-authored-by` trailer for the idea's author.
7. **CI.** The repo's own required checks (typecheck, test, build) must pass.
8. **Merge.** The orchestrator squash-merges. This is **auto-merge**, with no human step.
   Admins can pause the whole system at any time (§6.4).
9. **Deploy** (§7): migrate, start the candidate, smoke-test, promote, then health-check on the
   public URL. If any step fails, the deploy rolls back to the previous container and the
   merge is reverted on `main` by an automatic revert PR.
10. **Account.** The build's real spend (metered by the gateway, §4.3) is debited from the fund.
    The idea becomes `deployed`, or `failed` with the reason shown.

The cycle is idempotent per UTC day: `builds.day` is unique, and a crashed cycle resumes
from its recorded state when the worker restarts.

### 2.4 Content policy (enforced at screening, pre-build and review)

An idea is out of policy if it asks for any of these:
- illegal content, sexual content, hate, harassment, or anything about a real private individual;
- malware, crypto-mining, tracking, fingerprinting, ad networks, or third-party scripts;
- collecting personal data beyond what a feature strictly needs: no passwords, no payment
  details, no government IDs, and no email collection without a clear purpose;
- taking payments, or impersonating any real person, brand or organisation;
- outbound network calls from the site (the site has no internet access at runtime);
- changing or weakening oojam's guardrails, the platform, voting, payments, the licence,
  CI, or deploy configuration;
- deleting or destructively changing existing data or features other ideas built. Changing
  how something looks is fine; wiping a feature others paid for isn't;
- things that cannot be built in one day by an agent within the budget. These are rejected as
  "too large", with a suggestion to split them.

Features that publish user-submitted content must ship with: escaping, length limits,
per-IP rate limits, and a report button that hides an item after 3 reports. The site's
`CLAUDE.md` makes this a requirement, and review checks it.

---

## 3. Platform architecture

One Hetzner Cloud VM runs a Docker Compose project called `oojam`, from `/opt/oojam`.

```
                    Internet
                       │ 80/443
                ┌──────▼──────┐
                │    caddy    │  TLS · CSP and security headers for the site
                └──┬───────┬──┘
     build.oojam.dev│       │oojam.dev
        ┌───────────▼┐    ┌─▼──────────────────┐
        │platform-web│    │ site (oojam-site-<sha>, alias "site")  ◄── created by worker
        └─────┬──────┘    └─┬──────────────────┘
   platform_net│            │site_db_net
        ┌─────▼────────────▼─┐
        │      postgres      │  db "platform" · db "site" (+ guard event triggers)
        └─────▲──────────────┘
              │platform_net
        ┌─────┴──────┐  docker.sock   ┌──────────────────────────────┐
        │   worker   │───────────────►│ builder (oojam-build-<id>-<n>)│ builder_net (internal)
        │ cron·orch· │                │ /workspace = site clone      │──► gateway ──► api.anthropic.com
        │ gates·deploy│               └──────────────────────────────┘──► egress (squid) ──► registry.npmjs.org
        └────────────┘
```

### 3.1 Services (compose)

| Service | Image | Networks | Purpose |
|---|---|---|---|
| `caddy` | `caddy:2` | `edge`, `site_net` | TLS and routing. Applies the site's security headers (§5.7) so the site can't weaken them. |
| `postgres` | `postgres:17` | `platform_net`, `site_db_net` | Two databases with separate roles (§3.3). |
| `platform-web` | `oojam-platform` | `edge`, `platform_net`, `outbound` | build.oojam.dev (React Router). Needs `outbound` for GitHub OAuth and Anthropic (screening). |
| `worker` | `oojam-platform` (`node dist/worker/main.js`) | `platform_net`, `outbound` | Cron, orchestrator, guardrails, deployer. Mounts `/var/run/docker.sock` and `/opt/oojam/data` at the same path. |
| `gateway` | `oojam-platform` (`node dist/gateway/main.js`) | `builder_net`, `platform_net`, `outbound` | Anthropic API proxy for builders (§4.3). |
| `egress` | `ubuntu/squid` | `builder_net`, `outbound` | Allows only `CONNECT registry.npmjs.org:443`. |
| `backup` | `postgres:17` + script | `platform_net`, `site_db_net`, `outbound` | Nightly `pg_dump` of both DBs. 14 daily copies kept locally, plus optional upload to S3-compatible storage. |

Networks are created with fixed names (`oojam_edge`, `oojam_outbound`, `oojam_platform_net`,
`oojam_site_net`, `oojam_site_db_net`, `oojam_builder_net`). All except `edge` and `outbound`
are `internal: true` (no internet). The worker attaches dynamic containers to them by name.

### 3.2 Dynamic containers (created by the worker)

| Name | Image | Networks | Notes |
|---|---|---|---|
| `oojam-site-<sha12>` | `oojam-site:<sha12>` (built from the site repo's `Dockerfile`) | `oojam_site_net` (alias `site` when live, `site-candidate` while checked), `oojam_site_db_net` | `--read-only`, `tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`, 512 MB, 256 pids, `restart unless-stopped`, env `DATABASE_URL` (role `site_app`), `PORT=3000`, `GIT_SHA`. |
| `oojam-build-<buildId>-<attempt>` | `oojam-builder:<platform version>` | `oojam_builder_net` only | Mounts `/opt/oojam/data/builds/<id>/workspace` → `/workspace` and `/opt/oojam/data/builds/<id>/job-<n>` → `/job`. `--cap-drop ALL`, 4 GB, 1024 pids, wall clock `BUILD_TIMEOUT_MIN` (60). |
| `oojam-smoke-db-<id>` / `oojam-smoke-site-<id>` / `oojam-smoke-run-<id>` | `postgres:17` / `oojam-site:<sha>` / `oojam-builder` | `oojam_smoke_<id>` (created per build, internal) | Gate stage: restore the latest site backup, apply migrations, start the candidate, run the Playwright smoke test (§5.6). Removed afterwards. |

### 3.3 Databases and roles

`postgres` holds two databases. Each has a migrations role and an app role (used at runtime, DML
only). The databases themselves are owned by the superuser, so no application role can `DROP
DATABASE`, `ALTER DATABASE` or re-grant on `public`. The migrations role has `CONNECT` and `CREATE`
on its database and `USAGE, CREATE` on `public`. A read-only `backup` role (`pg_read_all_data`) takes
the nightly and pre-deploy dumps. The superuser can only log in over the Unix socket.

| DB | Migrations role | Runtime role | Used by |
|---|---|---|---|
| `platform` | `platform_owner` | `platform_app` | platform-web, worker, backup |
| `site` | `site_migrator` | `site_app` | site containers (runtime), deployer migration step |

`site_app` gets `SELECT, INSERT, UPDATE, DELETE` on all tables and `USAGE` on sequences
through `ALTER DEFAULT PRIVILEGES FOR ROLE site_migrator`. It can't create, alter or drop
anything. Neither role is a superuser, and neither can reach the other database
(`REVOKE CONNECT ... FROM PUBLIC`).

**Data-loss guards in the `site` DB**, installed by the superuser in init SQL. The roles above
can't remove them, because event triggers can only be dropped or disabled by their owner, a
superuser:

1. Event trigger `oojam_block_drops` (`sql_drop`). It raises an error if a command drops an
   object of type `table`, `table column`, `schema`, `sequence`, `materialized view` or
   `type`. Indexes and constraints may be dropped.
2. Event trigger `oojam_guard_new_tables` (`ddl_command_end`, `CREATE TABLE`). On each new
   table it attaches:
   - `BEFORE TRUNCATE` → raise;
   - `AFTER DELETE ... REFERENCING OLD TABLE FOR EACH STATEMENT` → raise if more than
     `oojam.max_delete_rows` (default 500) rows are deleted in one statement.
3. `site` DB `ALTER DATABASE ... SET statement_timeout = '30s'` for `site_app`.

The `platform` DB uses the same `oojam_block_drops` trigger, except while a maintainer runs
`deploy/bin/platform-migrate --allow-drops`, which disables it temporarily as the superuser.

**Backups:** nightly `pg_dump -Fc` of both databases, plus a pre-deploy dump of `site` before
every migration. Optional off-box copies go to Hetzner Object Storage (S3 API) through
`rclone` when `BACKUP_S3_*` is set.

---

## 4. The builder

### 4.1 Container image (`builder/`)

Node 22 + git + Chromium/Playwright + the Claude Agent SDK. The entry point is
`node /opt/oojam-builder/dist/run.js`. It:

1. reads `/job/job.json` (§4.4);
2. runs **one** Agent SDK `query()` in `/workspace` with:
   - the `claude_code` system prompt preset, plus `/opt/oojam-builder/BUILDER.md` appended;
   - tools `Read, Write, Edit, Glob, Grep, Bash, TodoWrite` (no Web*, no Task);
   - `permissionMode: 'acceptEdits'` and no prompts. A `PreToolUse` hook enforces the policy
     (§4.2);
   - `maxBudgetUsd` = job budget, `maxTurns` = 200, `settingSources: ['project']`
     (loads the site's `CLAUDE.md`);
3. writes `/job/result.json` (§4.4) and exits 0. It exits non-zero only if it crashes.

The builder **does not commit**. The worker stages and commits on the host after it exits.

### 4.2 Policy hook (best effort; the real boundary is §4.3 and §5)

Denied, with a reason the model sees:
- writes outside `/workspace` and `/tmp`, or to protected paths (§5.1);
- reading `/proc/*/environ`, `env`/`printenv`, and any reference to `ANTHROPIC_API_KEY`;
- `git push|remote|config`, `npm publish|adduser|login|token|owner`, `curl`, `wget`, `nc`,
  `ssh`, `scp`, `docker`, `sudo`;
- `rm -rf` on `/workspace` itself, `.git`, or the `drizzle/` directory;
- `npm install` of packages with install scripts (`--ignore-scripts` is forced through
  `npm_config_ignore_scripts=true` in the environment).

### 4.3 Network and credentials

- The builder never holds a real credential. `ANTHROPIC_API_KEY` in its environment is a
  **per-build random token**, and `ANTHROPIC_BASE_URL=http://gateway:8787`.
- **Gateway** (`src/gateway`):
  - It accepts the build token (as `x-api-key` or `Authorization: Bearer`), swaps in the
    real key, and forwards to `https://api.anthropic.com`, streaming both ways.
  - It meters every response from `usage` (JSON or SSE `message_start`/`message_delta`)
    against a price table (§9), and refuses with 429 once the token's budget is spent.
  - Admin API on `platform_net` only, using `GATEWAY_ADMIN_TOKEN`:
    `POST /admin/tokens {token, budgetUsd, label}`, `GET /admin/tokens/:token` → `{spentUsd}`,
    `DELETE /admin/tokens/:token`.
  - Only `POST /v1/messages` and `POST /v1/messages/count_tokens` are forwarded.
- **Egress**: `builder_net` is internal. The only ways out are the gateway and squid, which
  allows `CONNECT registry.npmjs.org:443` and nothing else. `HTTPS_PROXY`/`HTTP_PROXY` point
  at `http://egress:3128`. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### 4.4 Job files

`/job/job.json`:
```json
{ "buildId": 12, "attempt": 1, "model": "claude-opus-5-5", "effort": "high",
  "budgetUsd": 18.5, "idea": { "id": 4, "title": "...", "body": "...", "author": "octocat" },
  "feedback": null }
```
`feedback` holds the previous attempt's gate report as Markdown on attempt 2.

`/job/result.json`:
```json
{ "status": "done" | "gave_up" | "error", "summary": "markdown for the PR body",
  "costUsd": 4.21, "turns": 57, "error": null }
```
The builder declares `gave_up` (with a reason) when the idea can't be built within policy.
The idea is then `failed` with that reason.

---

## 5. Guardrails (host-side, `src/guardrails`)

The guardrails run on the diff between `main` and the builder's working tree after it exits.
Each check returns findings with `severity: "block" | "warn"`. **Any `block` fails the attempt.**
The report is Markdown, posted in the PR and stored in `builds.gate_report`.

### 5.1 Protected paths

The builder may not create, modify, delete or rename any of these:
`.github/**`, `LICENSE`, `CLAUDE.md`, `Dockerfile`, `.dockerignore`, `.npmrc`, `.nvmrc`,
`.oojam/**`, `scripts/migrate.mjs`, `app/routes/_health.ts`, `app/lib/oojam-identity.server.ts`,
`app/routes/_oojam.callback.ts`, `app/routes/_oojam.signout.ts`, `content/builds.json`,
`.claude/**`, `.mcp.json`, `.gitattributes`, `.gitmodules`, `.git/**`, and **existing** files
under `drizzle/*.sql` and `drizzle/meta/*_snapshot.json`.

It also blocks:
- symlinks;
- files over 1 MB;
- binary files outside `public/`;
- more than 200 changed files, or a total diff over 400 KB.

### 5.2 Migration lint

New `drizzle/*.sql` files are parsed after stripping comments, string literals and
dollar-quoted bodies.

**Allowed:**
- `CREATE TABLE`, `CREATE [UNIQUE] INDEX [CONCURRENTLY]`, `CREATE SEQUENCE`, `CREATE TYPE ... AS ENUM`;
- `ALTER TABLE ... ADD COLUMN | ADD CONSTRAINT | ALTER COLUMN ... SET DEFAULT | DROP DEFAULT | DROP NOT NULL`;
- `ALTER TYPE ... ADD VALUE`, `CREATE VIEW`;
- `INSERT`;
- `UPDATE ... WHERE` (but never an `UPDATE` without `WHERE`).

**Blocked:** everything else, including `DROP`, `TRUNCATE`, `DELETE`, `ALTER ... TYPE`,
`RENAME`, `SET NOT NULL` (it can fail on existing rows), `GRANT`/`REVOKE`, role or extension
statements, `DO`, `CREATE FUNCTION/PROCEDURE/TRIGGER/RULE/EVENT TRIGGER`, `COPY`, `SET ROLE`,
`SET SESSION`, and `ALTER SYSTEM`.

`drizzle/meta/_journal.json` may only gain entries at the end. Existing entries must be
byte-identical.

### 5.3 Dependencies

When `package.json` or `package-lock.json` changes:
- `scripts` keys `start`, `build`, `check`, `test`, `db:migrate`, `db:generate` must be
  unchanged. No lifecycle scripts may be added (`preinstall`, `install`, `postinstall`,
  `prepare`, `prepublish`, `prepack`, `postpack`);
- every new or upgraded dependency must:
  - be pinned to an exact version;
  - have been published at least `DEP_MIN_AGE_DAYS` (14) days ago;
  - not declare install scripts (`hasInstallScript` in the lockfile, or the registry manifest's
    `scripts.{pre,post,}install`);
  - resolve from `https://registry.npmjs.org/`;
  - not be deprecated;
- at most 5 new direct dependencies per build. A package name that is one edit away from one
  of the top 500 npm packages but isn't that package is a `block` (typosquat).

### 5.4 Secrets

Regexes across the diff for: Anthropic keys (`sk-ant-`), Stripe (`sk_live_`, `rk_live_`,
`whsec_`), GitHub tokens (`gh[pousr]_`, `github_pat_`), AWS (`AKIA`), private-key blocks,
Slack tokens, and generic high-entropy `*_KEY=`/`*_SECRET=` assignments → `block`.

### 5.5 Static patterns

| Pattern | Severity |
|---|---|
| `eval(`, `new Function(`, `child_process`, `vm.run*`, `process.binding` | block |
| `<script src=` or `import(` of an absolute `http(s)://` URL; `fetch`/`axios`/`http.request` to an absolute external URL | block |
| `process.env.X` where X is not `DATABASE_URL`, `PORT`, `NODE_ENV`, `GIT_SHA` | block |
| Mining or tracking signatures (`coinhive`, `cryptonight`, `stratum+tcp`, `googletagmanager`, `google-analytics`, `facebook.net`, `hotjar`, `segment.com`) | block |
| `dangerouslySetInnerHTML`, `innerHTML =`, raw SQL through `sql.raw(`/`.unsafe(` | warn (the reviewer must clear it) |
| `fs.` writes, `Math.random()` used for tokens, `localStorage` holding anything named token/password | warn |

### 5.6 Build, test and smoke

1. `docker build` the site image from the working tree. The site's `Dockerfile` runs
   `npm ci --ignore-scripts`, `npm run check`, `npm test` and `npm run build`. Any failure
   blocks.
2. Smoke test, on a per-build internal network:
   - restore the latest `site` backup into a scratch Postgres and apply the new migrations as
     `site_migrator`;
   - start the image as `site_app`, and wait for `GET /_health` to return `{ ok: true }`;
   - run the builder image's `smoke.js` (Playwright). It loads `/` plus up to 5 routes the
     builder listed in `result.json.routes`, and blocks on HTTP ≥ 500, console errors, failed
     requests, CSP violations, and any request to a non-same-origin host.

### 5.7 Edge-enforced headers (caddy, not the site)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-src 'none';
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff · Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
```
Caddy removes any of these the app sets and applies its own.

### 5.8 Claude review (independent of the builder)

A separate Agent SDK run on the host by the worker, using the **real** key directly, not the
build's token:
- read-only tools (`Read`, `Grep`, `Glob`) over the worker's own working tree;
- inputs: the idea, the diff, the static findings marked `warn`, the content policy, and the
  site's `CLAUDE.md`;
- outputs structured JSON:
  `{ verdict: "pass" | "fail", matchesIdea: boolean, findings: [{ severity, file, line, issue }] }`.
  `verdict: "fail"` or any `severity: "block"` finding blocks;
- it checks: security (XSS, injection, SSRF, authz, unsafe UGC), policy, scope (the change
  does what the idea asks and nothing unrelated), and data safety (doesn't remove other
  ideas' features).

Model `REVIEW_MODEL` (default `claude-opus-5-5`), effort `high`. Its cost is charged to the
build.

---

## 6. Platform app (build.oojam.dev)

### 6.1 Auth

GitHub OAuth (web flow, scope `read:user`). Accounts must be at least `MIN_GITHUB_ACCOUNT_AGE_DAYS`
(30) days old. Sessions are a random 32-byte token in an `HttpOnly; Secure; SameSite=Lax`
cookie `oojam_session`, stored as a SHA-256 hash in `sessions`, valid for 30 days. The OAuth
`state` is held in a short-lived signed cookie. Every state-changing route checks a CSRF
token: a double-submit token derived from the session (HMAC of the session id).

### 6.2 Schema (`platform` DB, Drizzle, `src/db/schema.ts`)

All money is integer **cents**. The fund balance is derived from append-only entries and never
stored on its own.

- `users(id, github_id unique, github_login, name, avatar_url, github_created_at, is_admin, banned_at, banned_reason, referred_by?, created_at)`
- `sessions(id text pk = sha256(token), user_id, expires_at, created_at)`
- `fund_entries(id, delta_cents, kind: build_spend|screening|adjustment, source, build_id?, actor_id?, note, created_at)`, the spend ledger. The table name and its unused `contribution` kind and `source` column are left over from an earlier funding model.
- `ideas(id, author_id, title, body, status: open|frozen|building|deployed|failed|rejected|withdrawn, vote_count, screen_verdict jsonb, rejected_reason, frozen_at, decided_at, created_at)`
- `votes(id, idea_id, user_id, referrer_id?, created_at)`, unique on `(idea_id, user_id)`.
- `shares(id, idea_id, user_id?, channel, created_at)` and `ref_visits(id, idea_id?, referrer_id, created_at)`.
- `comments(id, idea_id, user_id, body, hidden_at, created_at)`
- `builds(id, day date unique, idea_id, active_token, skipped_idea_ids jsonb, status: queued|screening|building|gating|pr_open|merging|deploying|deployed|failed|rolled_back|skipped, attempt, budget_cents, cost_cents, branch, pr_number, pr_url, merge_sha, gate_report text, summary text, error text, log jsonb, started_at, finished_at, created_at)`
- `deployments(id, build_id?, sha, container, status: candidate|live|retired|failed, created_at, promoted_at)`
- `controls(key pk, value jsonb, updated_by, updated_at)`. Keys: `paused` `{paused: bool, reason}`.
- `audit_log(id, actor_id?, action, subject, data jsonb, created_at)`

### 6.3 Vote and spend operations (`src/core/votes.ts`, `src/core/referrals.ts`, `src/core/spend.ts`)

Each vote operation is a single transaction, and `votes(idea_id, user_id)` is unique, so a vote
counts once however many times it's sent.

- `postIdea(userId, title, body)`:
  1. locks the user and checks they aren't banned;
  2. checks today's post and attempt limits;
  3. inserts the idea with `vote_count=1` and the author's vote.

  Screening happens **after** the transaction. A rejection calls `rejectAtScreening`, which
  removes the vote and marks the idea `rejected`.
- `vote(userId, ideaId, referrerId?)` and `unvote(userId, ideaId)`: lock the idea, check it's
  `open` and screened, insert or delete the vote, and adjust `vote_count`. Both are idempotent.
- `recordShare`, `recordRefVisit`, `setReferrer`, `referralSummary`, `topSharers` and
  `viralStats`: the sharing loop.
- `chargeBuild`, `chargeScreening` and `budgetLeftTodayCents` (`src/core/spend.ts`): the daily cap.

### 6.4 Admin

- `/admin` (`is_admin` users only):
  - pause or resume the cycle, with a reason. When paused, no freeze, build, merge or deploy
    happens, and a banner shows on both sites;
  - reject or hide ideas and hide comments, with a reason;
  - ban users;
  - run today's cycle now;
  - roll back to a previous deployment;
- Every admin action goes to `audit_log`, and the audit log is public at `/transparency`.

### 6.5 Sponsorship

There are no payments in the app. "Sponsor oojam" links on both sites go to `SPONSOR_URL`, which is
GitHub Sponsors for `oojam-dev`.

### 6.6 Routes

`/` board (Top · New · Built) · `/ideas/new` · `/ideas/:id` · `/builds` · `/builds/:id` ·
`/account` · `/costs` · `/rules` · `/transparency` · `/admin` · `/auth/github` ·
`/auth/github/callback` · `/auth/logout` · `/healthz`.

The oojam wordmark links to oojam.dev, and the "build" pill to the board. The header also shows
today's spend against the daily budget, a countdown to the next build, a Sponsor link and the paused
banner. The board's hero has a large live countdown to the next
build. oojam.dev shows one too.

---

### 6.7 Sign in with oojam (identity for oojam.dev)

oojam.dev has no accounts, secrets or network access, so build.oojam.dev vouches for visitors.
1. A "Sign in with GitHub" link on oojam.dev goes to `build.oojam.dev/connect?return=<path>`, which
   signs the visitor in with GitHub if needed. Banned users are refused.
2. The platform redirects to `oojam.dev/_oojam/callback?token=…&return=<path>`. The token is
   `base64url(payload).base64url(Ed25519 signature)`. Its payload is
   `{v:1, aud:"oojam.dev", sub:<github id>, login, iat, exp}`, valid for 7 days. It's signed with
   `OOJAM_IDENTITY_PRIVATE_KEY`, which only the platform holds.
3. The site checks it against the public key committed in `app/lib/oojam-identity.server.ts`, and
   stores it as the `oojam_viewer` cookie (`HttpOnly; Secure; SameSite=Lax`). It's verified again
   on every request by `getViewer()` and `requireViewer()`. `/_oojam/signout` clears it.
4. The identity module, the two routes and the three managed lines in `app/routes.ts` are
   protected (§5.1), so a build can't forge or bypass identity.

Policy: anything visitors **upload** (images, audio, video or files) requires a signed-in viewer,
stores their GitHub id and login, and shows "@login" publicly. Text submissions may stay
anonymous.

## 7. Deployer (`src/worker/deployer.ts`)

1. `docker build -t oojam-site:<sha12>` from the merged commit (a clean clone at `merge_sha`).
2. `pg_dump -Fc site` → `/opt/oojam/data/backups/site-predeploy-<sha12>.dump`.
3. Run `npm run db:migrate` in a one-off container from the new image on `oojam_site_db_net`
   with the `site_migrator` URL.
4. Start `oojam-site-<sha12>` on `oojam_site_net` (alias `site-candidate`) and
   `oojam_site_db_net`. Wait for `/_health` (90 s). The browser smoke test already ran at the gate
   against a restored copy of production data, so it isn't repeated here.
5. **Promote:**
   1. disconnect the candidate, then reconnect it with alias `site`;
   2. disconnect the old live container from `oojam_site_net` and stop it, keeping it as
      `retired` for rollback;
   3. remove anything older than the last 2 retired containers.
6. Check `https://oojam.dev/_health` through Caddy, which must report the new `sha`. On
   failure, reconnect the previous container as `site`, mark the build `rolled_back`, and open
   and merge a revert PR.

Migrations are additive (§5.2), so the old container keeps working against the new schema,
and rollback never touches data.

---

## 8. Configuration

| Var | Default | Used by |
|---|---|---|
| `PLATFORM_URL` | `https://build.oojam.dev` | web |
| `SITE_URL` | `https://oojam.dev` | web, worker |
| `DATABASE_URL` | — | web, worker |
| `SESSION_SECRET` | — | web |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | — | web |
| `ANTHROPIC_API_KEY` | — | web (screening), worker (review), gateway |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_FILE` / `GITHUB_APP_INSTALLATION_ID` | — | worker |
| `SITE_REPO` | `oojam-dev/oojam` | worker |
| `SITE_DB_MIGRATOR_URL` / `SITE_DB_APP_URL` | — | worker (passes them to containers) |
| `GATEWAY_URL` / `GATEWAY_ADMIN_TOKEN` | `http://gateway:8787` | worker, gateway |
| `MAX_IDEAS_PER_DAY` | `1` | core |
| `SPONSOR_URL` | `https://github.com/sponsors/oojam-dev` | core |
| `DAILY_BUDGET_USD` / `BUILD_BUDGET_MIN_USD` | `10` / `3` | worker, web |
| `BUILD_MODEL` / `BUILD_EFFORT` | `claude-opus-5-5` / `high` | worker |
| `REVIEW_MODEL` / `SCREEN_MODEL` | `claude-opus-5-5` | worker / web |
| `BUILD_TIMEOUT_MIN` | `60` | worker |
| `DEP_MIN_AGE_DAYS` | `14` | guardrails |
| `MIN_GITHUB_ACCOUNT_AGE_DAYS` | `30` | web |
| `CYCLE_CRON` | `0 0 * * *` (UTC) | worker |
| `DRY_RUN` | `false` | worker. When true: no push, PR, merge or deploy; everything else runs. |

## 9. Price table (USD per million tokens, `src/core/pricing.ts`)

| Model | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---|---|---|
| `claude-opus-5-5` | 4.00 | 20.00 | 5.00 | 8.00 | 0.20 |
| `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 4.00 | 0.20 |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |

An unknown model is priced as the most expensive known model.
