/** Applies the platform's Drizzle migrations to DATABASE_URL (run as platform_owner). */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
// src/scripts or dist/scripts → repo root
const migrationsFolder = join(here, "..", "..", "drizzle");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("migrate: platform migrations applied");
} catch (error) {
  console.error("migrate: failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
