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

  /** Ideas one account may post per UTC day (screening rejections don't count)… */
  get maxIdeasPerDay() { return num("MAX_IDEAS_PER_DAY", 1); },
  /** …and attempts, including rejected ones, so nobody can run up the screening bill. */
  get maxPostAttemptsPerDay() { return num("MAX_POST_ATTEMPTS_PER_DAY", 3); },
  /** Where "Sponsor oojam" points. Sponsorship funds builds; it never buys votes. */
  get sponsorUrl() { return str("SPONSOR_URL", "https://github.com/sponsors/oojam-dev"); },
  /** The most oojam spends on Claude per UTC day: the build, its review and idea screening. */
  get dailyBudgetUsd() { return num("DAILY_BUDGET_USD", 10); },
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
