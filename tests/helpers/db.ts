/**
 * Integration tests run against a real Postgres. Set TEST_DATABASE_URL to a server you can
 * create databases on (e.g. `docker run -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17`
 * and TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres). Each test file
 * gets a fresh database with the migrations applied. Without it, these tests are skipped.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const hasDb = Boolean(TEST_DB_URL);

export async function freshDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const admin = postgres(TEST_DB_URL!, { max: 1, onnotice: () => {} });
  const name = `oojam_test_${randomBytes(4).toString("hex")}`;
  await admin.unsafe(`create database ${name}`);
  const url = new URL(TEST_DB_URL!);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: join(import.meta.dirname, "..", "..", "drizzle") });
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

let nextGithubId = 1000;
export async function makeUser(db: Database, opts: Partial<typeof schema.users.$inferInsert> = {}) {
  const id = nextGithubId++;
  const [u] = await db
    .insert(schema.users)
    .values({ githubId: id, githubLogin: `user${id}`, ...opts })
    .returning();
  return u!;
}

/** Gives a user wallet credit the way a real paid top-up would. */
export async function fund(db: Database, userId: number, cents: number) {
  const [t] = await db
    .insert(schema.topups)
    .values({ userId, amountCents: cents, status: "paid", stripeCheckoutId: `cs_${randomBytes(6).toString("hex")}` })
    .returning();
  await db.insert(schema.walletEntries).values({ userId, deltaCents: cents, kind: "topup", topupId: t!.id });
}
