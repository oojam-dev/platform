/** Configuration from the environment (SPEC §8). Read lazily so tests can set env first. */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set`);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  get platformUrl() { return str("PLATFORM_URL", "http://localhost:3000"); },
  get siteUrl() { return str("SITE_URL", "https://oojam.dev"); },
  get databaseUrl() { return str("DATABASE_URL"); },
  get sessionSecret() { return str("SESSION_SECRET"); },
  get githubOAuthClientId() { return str("GITHUB_OAUTH_CLIENT_ID"); },
  get githubOAuthClientSecret() { return str("GITHUB_OAUTH_CLIENT_SECRET"); },
  get stripeSecretKey() { return str("STRIPE_SECRET_KEY"); },
  get stripeWebhookSecret() { return str("STRIPE_WEBHOOK_SECRET"); },
  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY || undefined; },

  get githubAppId() { return str("GITHUB_APP_ID"); },
  get githubAppPrivateKeyFile() { return str("GITHUB_APP_PRIVATE_KEY_FILE", "/run/secrets/github-app.pem"); },
  get githubAppInstallationId() { return str("GITHUB_APP_INSTALLATION_ID"); },
  get siteRepo() { return str("SITE_REPO", "oojam-dev/oojam"); },
  /** Where builds fetch main from. Defaults to the public GitHub repo; a local path for development. */
  get siteRepoUrl() { return str("SITE_REPO_URL", `https://github.com/${this.siteRepo}.git`); },
  get siteDbMigratorUrl() { return str("SITE_DB_MIGRATOR_URL"); },
  get siteDbAppUrl() { return str("SITE_DB_APP_URL"); },
  get gatewayUrl() { return str("GATEWAY_URL", "http://gateway:8787"); },
  get gatewayAdminToken() { return str("GATEWAY_ADMIN_TOKEN"); },
  get dataDir() { return str("OOJAM_DATA_DIR", "/opt/oojam/data"); },
  get builderImage() { return str("BUILDER_IMAGE", "oojam-builder:latest"); },
  /** The pinned Postgres image, for scratch databases in the gate. */
  get postgresImage() { return str("POSTGRES_IMAGE", "postgres:17"); },

  get buildFundShare() { return num("BUILD_FUND_SHARE", 0.8); },
  get maxVotesPerUserPerIdea() { return num("MAX_VOTES_PER_USER_PER_IDEA", 10); },
  get buildBudgetCapUsd() { return num("BUILD_BUDGET_CAP_USD", 25); },
  get buildBudgetMinUsd() { return num("BUILD_BUDGET_MIN_USD", 3); },
  get buildModel() { return str("BUILD_MODEL", "claude-opus-5-5"); },
  get buildEffort() { return str("BUILD_EFFORT", "high"); },
  get reviewModel() { return str("REVIEW_MODEL", "claude-opus-5-5"); },
  get screenModel() { return str("SCREEN_MODEL", "claude-opus-5-5"); },
  get buildTimeoutMin() { return num("BUILD_TIMEOUT_MIN", 60); },
  get depMinAgeDays() { return num("DEP_MIN_AGE_DAYS", 14); },
  get minGithubAccountAgeDays() { return num("MIN_GITHUB_ACCOUNT_AGE_DAYS", 30); },
  get cycleCron() { return str("CYCLE_CRON", "0 0 * * *"); },
  get dryRun() { return bool("DRY_RUN", false); },
  get adminGithubLogins() {
    return str("ADMIN_GITHUB_LOGINS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  },
};

/** One credit is one dollar. */
export const CREDIT_CENTS = 100;
export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 50_000;
export const TOPUP_PRESETS_CENTS = [500, 1_000, 2_500] as const;
