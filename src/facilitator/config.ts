import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";
import type { PolicyConfig } from "./policy";
import { toAtomic } from "../shared/amount";
import { USDC_DECIMALS } from "../shared/chain-constants";

const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  /**
   * Railway, Render and most PaaS assign the port through $PORT and route
   * traffic there. Listening on our own default instead means the health
   * check fails with nothing in the logs to explain it.
   *
   * PORT wins when present; FACILITATOR_PORT stays for running two
   * services on one machine locally.
   */
  PORT: z.coerce.number().int().positive().optional(),
  FACILITATOR_PORT: z.coerce.number().int().positive().default(DEFAULTS.FACILITATOR_PORT),

  /**
   * No default. Settling with no record is the failure the ledger exists to
   * prevent, so a facilitator that cannot reach Postgres must refuse to
   * start rather than quietly settle into nothing.
   */
  DATABASE_URL: z.string().url("must be a postgres:// connection string"),

  /** Per-payment cap, atomic units. Refuses one oversized payment. */
  STIPEND_MAX_PER_PAYMENT: z.coerce.bigint().positive().default(10_000n),
  /** Total across the window, atomic units. THIS is the spend limit. */
  STIPEND_WINDOW_CAP: z.coerce.bigint().positive().default(50_000n),
  /** Window length in hours. */
  /**
   * Window length in MINUTES, not hours.
   *
   * Ten minutes, deliberately short for a demo: if a visitor exhausts the
   * budget, a judge arriving afterwards waits ten minutes rather than an
   * hour, and the dashboard counts down to it. A realistic window would
   * be hours; a demonstrable one self-heals while someone is still
   * watching.
   */
  STIPEND_WINDOW_MINUTES: z.coerce.number().positive().default(10),
});

export type FacilitatorConfig = {
  chain: ChainConfig;
  port: number;
  databaseUrl: string;
  policy: PolicyConfig;
};

/** Called ONCE by the entrypoint. Never at import time (D3). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const e = parseEnv("facilitator", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    port: e.PORT ?? e.FACILITATOR_PORT,
    databaseUrl: e.DATABASE_URL,
    policy: {
      maxAtomicPerPayment: toAtomic(e.STIPEND_MAX_PER_PAYMENT, USDC_DECIMALS),
      windowCapAtomic: toAtomic(e.STIPEND_WINDOW_CAP, USDC_DECIMALS),
      windowMs: e.STIPEND_WINDOW_MINUTES * 60 * 1000,
    },
  };
}
