/**
 * The database connection, as a factory (mirrors createChain, D15).
 *
 * Nothing is constructed at import time, so a test passes PGlite and
 * production passes postgres.js with no module stubbing.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const client = postgres(url, {
    max: 10,
    idle_timeout: 20,   // seconds, not ms
    connect_timeout: 10,
  });
  return {
    db: drizzle({ client, schema }),
    /** Rejects new queries, waits for in-flight ones, then closes. */
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Apply migrations on a SEPARATE single connection.
 *
 * max:1 because migrations must run in order on one session — a pool would
 * let two run concurrently against different connections.
 */
export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end({ timeout: 5 });
  }
}
