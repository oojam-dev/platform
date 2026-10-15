# oojam deploy runbook

Everything that runs on the oojam server: one Docker Compose project (`oojam`), run from
`/opt/oojam/platform/deploy` on the VM that [`../infra`](../infra/README.md) creates.
SPEC §3, §4.3, §5.7, §7 and §8 are the contract; this is how to operate it.

```
compose.yml               caddy, postgres, platform-web, worker, gateway, egress, backup + the 6 networks
.env.example              every setting (copy to .env; bin/bootstrap fills the generated secrets)
caddy/Caddyfile           TLS, routing, SPEC §5.7 headers; caddy/fallback/ = "oojam is being born"
postgres/initdb/          01-init.sh (roles, dbs, grants, pg_hba), 02-guards.sql (data-loss guards)
postgres/test/guards.sh   throwaway-container test of all of the above (125 checks)
squid/squid.conf          egress: CONNECT registry.npmjs.org:443 only; squid/test.sh
backup/                   nightly pg_dump + rclone image (backup.sh loop|now|health)
bin/bootstrap             first boot
bin/update-platform       deploy a new platform version
bin/platform-migrate      platform DB migrations (--allow-drops)
bin/restore               restore a dump over platform or site
secrets/github-app.pem    the GitHub App private key (you create it; git-ignored)
```

What runs where:

| Service | Networks | Notes |
|---|---|---|
| caddy | edge, site_net | Ports 80, 443 (tcp+udp). Admin API on 127.0.0.1 inside the container only. |
| postgres | platform_net, site_db_net | Data in `/opt/oojam/data/postgres`. Superuser only via the container's Unix socket. |
| platform-web | edge, platform_net, outbound | build.oojam.dev. Runs as `node`, read-only root. |
| worker | platform_net, outbound | Root, Docker socket, `/opt/oojam/data`. Creates the site, builder and smoke containers. |
| gateway | builder_net, platform_net, outbound | Anthropic proxy for builders (port 8787). Runs as `node`, read-only root. |
| egress | builder_net, outbound | squid, `registry.npmjs.org:443` only. |
| backup | platform_net, site_db_net, outbound | 03:30 UTC `pg_dump` of both DBs, read-only DB role. |

Networks are created as `oojam_edge`, `oojam_outbound` (internet) and `oojam_platform_net`,
`oojam_site_net`, `oojam_site_db_net`, `oojam_builder_net` (internal: no internet).

All commands below run on the server as `oojam`, in `/opt/oojam/platform/deploy`, unless said otherwise.

---

## First-time setup

### 1. Server

`infra/README.md`: `terraform apply`, then wait for cloud-init (`cloud-init status --wait`).

### 2. DNS

`terraform output dns_records` lists them. At the DNS provider:

| Name | Type | Value |
|---|---|---|
| `oojam.dev` | A / AAAA | server IPv4 / IPv6 |
| `www.oojam.dev` | A / AAAA | same |
| `build.oojam.dev` | A / AAAA | same |
| `oojam.dev` | CAA | `0 issue "letsencrypt.org"` (optional, recommended) |

Caddy gets certificates on first request once these resolve. Check: `dig +short build.oojam.dev A AAAA`.

### 3. GitHub OAuth app (sign-in on build.oojam.dev)

GitHub → the `oojam-dev` org → Settings → Developer settings → OAuth Apps → New:
- Homepage URL `https://build.oojam.dev`
- Authorization callback URL `https://build.oojam.dev/auth/github/callback`
- No device flow.

Put the client ID and a new client secret in `.env` as `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`.
The app only asks for `read:user`.

### 4. GitHub App (PRs and merges on oojam-dev/oojam)

GitHub → `oojam` org → Settings → Developer settings → GitHub Apps → New:
- Name e.g. `oojam-builder`; homepage `https://build.oojam.dev`; **webhooks off**.
- Repository permissions: **Contents: Read & write**, **Pull requests: Read & write**,
  **Checks: Read & write**, Metadata: Read (automatic). Nothing else; no organisation or account permissions.
- "Only on this account". Create, then **Generate a private key** (downloads a `.pem`).
- Install it on the `oojam-dev` org → **Only select repositories → `oojam-dev/oojam`**. Never on `oojam-dev/platform`.
- `GITHUB_APP_ID` = the App ID on its settings page; `GITHUB_APP_INSTALLATION_ID` = the number at the end of
  the installation's URL (`…/settings/installations/<id>`).
- Copy the key to the server and lock it down:
  ```sh
  scp oojam-builder.*.private-key.pem oojam@<server>:/opt/oojam/platform/deploy/secrets/github-app.pem
  chmod 600 secrets/github-app.pem
  ```

Branch protection on `oojam-dev/oojam` `main` (Settings → Branches, or a ruleset):
- Require a pull request before merging; **required approvals: 0** (the merge is automatic, SPEC §2.3 step 8).
- Require status checks to pass: the repo's CI jobs (typecheck, test, build). Require branches to be up to date.
- Block force pushes and deletions. Restrict who can push to `main` to maintainers and the App.
- Squash merging allowed.

### 5. Sponsorship (optional)

oojam takes no payments. Voting is free; builds are paid for from the build fund, which the
maintainers and sponsors top up.

- Enable GitHub Sponsors for the `oojam-dev` org (github.com/sponsors). `.github/FUNDING.yml` in both
  repos already points at it, and `SPONSOR_URL` sets where the "Sponsor" links on both sites go.
- When money goes into the Anthropic account for oojam, record it in `/admin` → **Record a
  contribution**, so `/fund` stays accurate. Sponsorship never buys votes.

### 6. Anthropic

Console → create a workspace for oojam with a **monthly spend limit** (a little above what the build fund
could ever spend: `BUILD_BUDGET_CAP_USD` × 2 attempts × 31 days + review and screening) → API key →
`ANTHROPIC_API_KEY`. The gateway enforces per-build budgets; the workspace limit is the backstop.

### 7. Configure and start

```sh
cd /opt/oojam/platform/deploy
cp .env.example .env && chmod 600 .env
$EDITOR .env      # ACME_EMAIL, ADMIN_GITHUB_LOGINS, the keys above; leave generated ones empty
bin/bootstrap     # generates DB passwords and secrets, checks everything, builds, starts
```

`bin/bootstrap` is safe to re-run; it stops and lists anything still missing. On the first start Postgres
runs `postgres/initdb/01-init.sh`: roles, the `platform` and `site` databases, the guards.

Then:
- open `https://build.oojam.dev/` and sign in; logins in `ADMIN_GITHUB_LOGINS` are admins;
- `https://oojam.dev/` shows "oojam is being born" until the first deploy;
- take a first backup: `docker compose exec backup backup.sh now`;
- **copy `.env` and `secrets/github-app.pem` into the team password manager.** Without the DB passwords
  in `.env` the backups are still restorable (as the superuser), but the services can't reconnect.

### 8. First cycle

`.env.example` starts with `DRY_RUN=true`: the cycle freezes, builds, gates and reviews, but never
pushes, opens a PR, merges or deploys. Trigger one from `/admin` → "run today's cycle now", watch
`docker compose logs -f worker`, read the build page. When it looks right:

```sh
sed -i 's/^DRY_RUN=.*/DRY_RUN=false/' .env && docker compose up -d worker
```

---

## Day to day

```sh
docker compose ps                                  # health of every service
docker compose logs -f --since 1h worker           # the cycle (also: platform-web, gateway, caddy, egress)
docker ps --filter name=oojam-                     # site, builder and smoke containers
ls -lh /opt/oojam/data/backups; cat /opt/oojam/data/backups/.last-success
df -h / /opt/oojam/data
```

Health endpoints: `https://build.oojam.dev/healthz` (web + DB), `https://oojam.dev/_health` (live site,
reports its `sha`).

## Updating the platform

```sh
bin/update-platform
```

`git pull --ff-only`, build the platform, backup and builder images, run platform migrations, `up -d`.
It refuses while a builder or smoke container is running (`--force` overrides; the worker resumes the
cycle after a restart). The previous platform image stays tagged `oojam-platform:previous`.

Before building it checks that the repo's root `.dockerignore` excludes `deploy/.env` and
`deploy/secrets`: the platform image is built with the whole repo as context.

**Rolling back the platform** (code only; migrations aren't reversed, so only roll back across additive
migrations):
```sh
git log --oneline -5
git checkout <good-sha>               # detached; bin/update-platform --no-pull builds it
bin/update-platform --no-pull
# quick alternative without rebuilding:
docker tag oojam-platform:previous oojam-platform:latest && docker compose up -d
```
Return to `main` with `git checkout main` before the next `bin/update-platform`.

**Platform migrations that drop things.** The `platform` DB has the same drop guard as the site. A
migration that drops a column/table/type fails with `oojam guard: … may not drop …`. Take a backup, then:
```sh
docker compose exec backup backup.sh now
bin/platform-migrate --allow-drops
```
It disables `oojam_block_drops` (as the superuser) only while the migration runs and re-enables it on any
exit. TRUNCATE and the 500-row DELETE limit stay on: clear tables with batched deletes. Then
`docker compose up -d`.

## Backups

- **Nightly**, 03:30 UTC (`BACKUP_TIME`): `pg_dump -Fc` of `platform` and `site` →
  `/opt/oojam/data/backups/{platform,site}-YYYYMMDD.dump`, newest 14 kept (`BACKUP_KEEP_DAYS`). Each dump
  is checked with `pg_restore --list` before it replaces anything.
- **Pre-deploy**: the worker writes `site-predeploy-<sha12>.dump` before every site migration (SPEC §7);
  the backup service keeps the newest 3 and prunes older ones after 14 days.
- **Off-box** (strongly recommended): set `BACKUP_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY` (Hetzner Object
  Storage: create a bucket in another location than the server, e.g. `fsn1` when the server is in `nbg1`,
  and an S3 credential scoped to it). Set `BACKUP_ENCRYPTION_PASSWORD` to encrypt the copies (rclone
  crypt); store it with `.env`. Expire old objects with a bucket lifecycle rule (e.g. 60 days); the backup
  service never deletes remote objects. `docker compose up -d backup` after changing these.
- **Monitoring**: `.last-success` (time + epoch), `.last-upload`, `.last-error` in the backups directory;
  the `backup` container turns unhealthy when the last success is more than 26 h old.
- **Now**: `docker compose exec backup backup.sh now`.

The DB role `backup` is read-only (`pg_read_all_data`); the superuser never leaves the postgres container.

**Restoring off-box copies** (from any machine with rclone):
```sh
export RCLONE_CONFIG_S3_TYPE=s3 RCLONE_CONFIG_S3_PROVIDER=Other RCLONE_CONFIG_S3_ENDPOINT=<endpoint> \
       RCLONE_CONFIG_S3_ACCESS_KEY_ID=<key> RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=<secret>
# encrypted copies:
export RCLONE_CONFIG_C_TYPE=crypt RCLONE_CONFIG_C_REMOTE=s3:<bucket>/oojam \
       RCLONE_CONFIG_C_PASSWORD=$(rclone obscure '<BACKUP_ENCRYPTION_PASSWORD>')
rclone ls c:            # or: rclone ls s3:<bucket>/oojam
rclone copy c:site-20261014.dump .
```

## Restore

```sh
bin/restore                                         # lists local backups
bin/restore site /opt/oojam/data/backups/site-20261014.dump
bin/restore platform /opt/oojam/data/backups/platform-20261014.dump
```

You type the database name to confirm. It saves the current database to `<db>-prerestore-<time>.dump`
first, stops what uses it (platform: web + worker; site: worker + the live site container), drops the
database, `pg_restore --create`s the dump (which brings back the grants and per-role settings), re-applies
the guards, and starts everything again. If `pg_restore` fails it says how to put the saved copy back.

Restoring the platform DB rewinds votes, ideas and the fund ledger to the dump's time; re-record any
contributions made since, from `/transparency`.

**Test a restore** every few months: `bin/restore` on a staging box, or restore into a scratch container:
```sh
docker run --rm -d --name restore-test -e POSTGRES_PASSWORD=x postgres:17
docker cp /opt/oojam/data/backups/site-YYYYMMDD.dump restore-test:/tmp/
docker exec restore-test sh -c 'sleep 5; createdb -U postgres site && pg_restore -U postgres --no-owner --no-acl -d site /tmp/site-YYYYMMDD.dump && psql -U postgres -d site -c "\dt"'
docker rm -f restore-test
```

## Pausing the system

- **Normal**: `/admin` → Pause (with a reason). No freeze, build, merge or deploy happens; a banner shows on
  both sites. Voting keeps working. Resume from the same page.
- **Hard stop of the cycle** (admin UI unavailable, or something is going wrong right now):
  ```sh
  docker compose stop worker
  docker ps --filter name=oojam-build- --filter name=oojam-smoke- -q | xargs -r docker rm -f
  ```
  The site and build.oojam.dev stay up. `docker compose start worker` resumes (the cycle picks up from its
  recorded state; pause in /admin first if it shouldn't).
- **Stop spending**: revoke the Anthropic key in the console (the gateway, screening and review fail
  closed).
- **Take build.oojam.dev offline** (keeps the site): `docker compose stop platform-web` (Caddy shows a
  "restarting" page).

## Rolling back the site

Use `/admin` → roll back to a previous deployment: it records the change in `deployments` and the audit log.

By hand, if the platform can't (SPEC §7 step 5 keeps the last 2 retired containers):
```sh
docker ps -a --filter name=oojam-site- --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
CUR=$(docker ps --filter network=oojam_site_net --filter name=oojam-site- --format '{{.Names}}' | head -1)
OLD=oojam-site-<sha12>
docker start "$OLD"
docker network connect --alias site oojam_site_net "$OLD"
docker network disconnect oojam_site_net "$CUR" && docker stop "$CUR"
curl -s https://oojam.dev/_health          # must report the old sha
```
Then pause the cycle and revert the bad merge on `oojam-dev/oojam` (a revert PR), so the next deploy doesn't
bring it back. Migrations are additive, so the old container works against the current schema.

## Rotating secrets

After editing `.env`, `docker compose up -d` recreates exactly the services whose environment changed.

| Secret | How |
|---|---|
| `SESSION_SECRET` | New value (`openssl rand -hex 32`), `up -d`. Everyone is signed out. |
| `GATEWAY_ADMIN_TOKEN` | New value; do it between cycles (in-flight build tokens die with the gateway restart). |
| `ANTHROPIC_API_KEY` | New key in the console, update `.env`, `up -d`, revoke the old key. |
| `GITHUB_OAUTH_CLIENT_SECRET` | Generate a second secret, update, `up -d`, delete the old one. |
| GitHub App key | Generate a new key, replace `secrets/github-app.pem`, `docker compose restart worker`, delete the old key on GitHub. |
| `PLATFORM_APP_PASSWORD`, `PLATFORM_OWNER_PASSWORD`, `BACKUP_DB_PASSWORD` | See below; then `up -d`. |
| `SITE_MIGRATOR_PASSWORD` | See below; `up -d` (the worker passes it to deploy migrations). |
| `SITE_APP_PASSWORD` | See below. The live site container keeps the old URL in its environment until the worker creates the next one, and loses DB access on its next new connection: rotate right before a deploy, or have the worker recreate the live container immediately. |
| `POSTGRES_PASSWORD` | Unused after first boot (the superuser can't log in over the network). Leave it. |

Database passwords (hex only: they go into URLs):
```sh
NEW=$(openssl rand -hex 32)
docker compose exec -T postgres psql -U postgres -c "ALTER ROLE platform_app PASSWORD '$NEW'"
sed -i "s/^PLATFORM_APP_PASSWORD=.*/PLATFORM_APP_PASSWORD=$NEW/" .env
docker compose up -d
```

## Incident checklist

1. **Stop the bleeding.** Pause in `/admin`, or hard-stop the worker (above). If money or keys are
   involved: revoke the Anthropic key, suspend the GitHub App installation
   (GitHub → org settings → Installed GitHub Apps → Suspend).
2. **Preserve evidence** before changing things: `docker compose logs --since 48h > /opt/oojam/data/incident-$(date -u +%F).log`,
   `docker ps -a`, `docker inspect` of suspicious containers, `docker compose exec backup backup.sh now`.
   For a builder container: `docker logs oojam-build-<id>-<n>`, and `/opt/oojam/data/builds/<id>/`.
3. **Site broken?** Roll back the site (above). Caddy serves the "being born" page if no site container answers.
4. **Data damaged?** The guards stop drops, TRUNCATE and bulk deletes; anything else: `bin/restore` from the
   last good dump (pre-deploy dumps are taken right before each migration).
5. **Server compromised?** Assume `.env` is known: rotate every secret above, re-create the server from
   `infra/` (new volume, restore from the off-box backup), re-issue the GitHub App key.
6. **Egress anomaly?** `docker compose logs egress | grep TCP_DENIED` shows what builders tried to reach;
   `sudo iptables -L OOJAM-EGRESS -v -n` shows hits on the metadata/SMTP blocks.
7. Write it up on `/transparency` (admin actions are already logged there).

---

## Reference

### Data-loss guards (postgres/initdb/02-guards.sql)

Installed by the superuser in both databases; the application roles can't alter or drop them.
- `oojam_block_drops` (sql_drop): no dropping tables, columns, schemas, sequences, materialized views,
  types, or the guard triggers. Indexes, constraints, views, functions and temporary objects are fine.
- `oojam_guard_new_tables` (ddl_command_end): every new table gets `oojam_no_truncate` (BEFORE TRUNCATE
  → error) and `oojam_delete_limit` (a statement deleting more than 500 rows → error, cascades included).
- `oojam_guard_triggers`: no disabling or renaming those triggers.
- `SET oojam.max_delete_rows = N` lowers the limit for a session; only a superuser session can raise it.
- Superuser escape hatch for maintenance: `SET session_replication_role = replica` in a
  `docker compose exec postgres psql -U postgres -d <db>` session.

Run the tests (needs Docker; ~30 s): `postgres/test/guards.sh`.

### Database roles

| Role | Can |
|---|---|
| `platform_owner` | connect + create in `platform` (migrations; owns the platform's tables) |
| `platform_app` | DML on `platform` tables; statement_timeout 30 s |
| `site_migrator` | connect + create in `site` (deploy migrations; owns the site's tables) |
| `site_app` | DML on `site` tables in `public`; statement_timeout 30 s |
| `backup` | read everything (`pg_read_all_data`) in both |
| `postgres` | superuser; Unix socket inside the container only |

The databases themselves are owned by the superuser, so no application role can `DROP DATABASE` or
`ALTER DATABASE`. No role can connect to the other database, to `postgres` or to `template1`.

### Updating pinned images

caddy, postgres and squid are pinned by digest in `compose.yml` (postgres also in `backup/Dockerfile` and
`postgres/test/guards.sh`; `bin/*` tag it as `postgres:17` for the worker's throwaway containers).
```sh
docker pull caddy:2.11.5 && docker image inspect --format '{{index .RepoDigests 0}}' caddy:2.11.5
```
Stay on Postgres 17 (a major upgrade needs dump and restore) and on the same Debian release (collations).
Run `postgres/test/guards.sh` and `squid/test.sh` after bumping postgres or squid.
