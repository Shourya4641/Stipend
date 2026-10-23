/**
 * Parse process.env against a schema, reporting EVERY problem at once (D3).
 *
 * One-per-restart discovery wastes a session. Called from each role's
 * loadConfig(), never at import time.
 */
import { config as loadDotenv } from "dotenv";
import type { z } from "zod";

/**
 * Load .env into process.env, once.
 *
 * Called from parseEnv rather than at import time, so merely importing a
 * config module still has no side effects (D3). A real deployment injects
 * variables and has no .env file; dotenv is a no-op then.
 */
let dotenvLoaded = false;
function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  loadDotenv({ quiet: true });
}

export class ConfigError extends Error {
  constructor(role: string, issues: string[]) {
    super(`${role}: invalid configuration\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Infers from the SCHEMA, not from a named type. `z.ZodType<T>` makes input
 * and output both T, but `.default()` has input `string | undefined` and
 * output `string` — naming the type collapses them and every defaulted
 * field comes back optional.
 */
export function parseEnv<S extends z.ZodTypeAny>(
  role: string,
  schema: S,
  env: unknown,
): z.infer<S> {
  ensureDotenv();
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  throw new ConfigError(
    role,
    result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  );
}

/** Devnet RPC and localhost ports MAY default — the default is the safe case. */
export const DEFAULTS = {
  RPC_URL: "https://api.devnet.solana.com",
  MERCHANT_URL: "http://127.0.0.1:4021",
  FACILITATOR_URL: "http://127.0.0.1:3000",
  MERCHANT_PORT: 4021,
  FACILITATOR_PORT: 3000,
} as const;
