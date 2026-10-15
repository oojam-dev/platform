# oojam platform

The machine behind [oojam.dev](https://oojam.dev), a website with no designated purpose:
- people commit dollars on [build.oojam.dev](https://build.oojam.dev) to post and upvote ideas;
- every day at 00:00 UTC the top idea is frozen;
- Claude builds it into the open-source site ([oojam-dev/oojam](https://github.com/oojam-dev/oojam));
- the change passes guardrails, is merged as a PR, and is deployed.

[`SPEC.md`](SPEC.md) is the design and the contract between the parts. Start there.

## What's in here

| Path | What |
|---|---|
| `app/` | build.oojam.dev: the board, ideas, votes, wallet, fund, rules, admin (React Router v7). |
| `src/core/` | Domain logic: the ledger (money), ideas and screening, auth, Stripe, controls, policy. |
| `src/db/` | Drizzle schema and client for the `platform` database; migrations in `drizzle/`. |
| `src/guardrails/` | Host-side checks on every build: protected paths, additive-only migrations, dependency vetting, secrets, code patterns, and the independent Claude review. |
| `src/gateway/` | Anthropic API proxy. Builders get a per-build token, never the key, and their spend is metered and capped. |
| `src/worker/` | The daily cycle: freeze, screen, build, gate, PR, CI, merge, deploy, roll back. |
| `builder/` | The builder container: the Claude Agent SDK with a policy hook, plus the Playwright smoke tester. |
| `deploy/` | Docker Compose stack, Caddy, Postgres roles and data-loss guards, squid egress, backups, and the operator runbook. |
| `infra/` | Terraform and cloud-init for the Hetzner server. |

## The wall

The builder only ever touches the site repo. It never sees this repo, the platform database, the
Anthropic key or a GitHub token. Everything that judges its work runs outside its container. That
way the community can't vote its way past the rules.

## Development

```bash
npm install
docker run -d --name oojam-pg -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:17
export DATABASE_URL=postgres://postgres:dev@localhost:55432/postgres
npm run db:migrate
SESSION_SECRET=dev PLATFORM_URL=http://localhost:3000 npm run dev
```

Tests (money and ledger tests need a Postgres you can create databases on):

```bash
TEST_DATABASE_URL=postgres://postgres:dev@localhost:55432/postgres npm test
(cd builder && npm install && npm test)
```

To try the real gate pipeline locally (Docker build, migrations against the production guards, a
browser smoke test, and a malicious change being blocked) without spending anything on the
model:

```bash
docker build -t oojam-builder:latest builder/
npx tsx scripts/gate-local.ts ../site
```

`DRY_RUN=true` runs the whole cycle, including a real build, but doesn't push, open a PR, merge or
deploy.

## Deploying

See [`deploy/README.md`](deploy/README.md) and [`infra/terraform/README.md`](infra/terraform/README.md).

## Licence

MIT.
