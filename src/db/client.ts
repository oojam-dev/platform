import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "../core/config.js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

const g = globalThis as unknown as { __oojamDb?: { db: Database; sql: postgres.Sql } };

/** Lazily opens the pool; cached on globalThis so dev-server reloads reuse it. */
export function getDb(): Database {
  if (!g.__oojamDb) {
    const sql = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
    g.__oojamDb = { db: drizzle(sql, { schema }), sql };
  }
  return g.__oojamDb.db;
}

export async function closeDb(): Promise<void> {
  if (g.__oojamDb) {
    await g.__oojamDb.sql.end({ timeout: 5 });
    delete g.__oojamDb;
  }
}

export { schema };
