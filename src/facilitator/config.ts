import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";
import type { PolicyConfig } from "./policy";
import { toAtomic } from "../shared/amount";
import { USDC_DECIMALS } from "../shared/chain-constants";

const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
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
  STIPEND_WINDOW_HOURS: z.coerce.number().positive().default(1),
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
    port: e.FACILITATOR_PORT,
    databaseUrl: e.DATABASE_URL,
    policy: {
      maxAtomicPerPayment: toAtomic(e.STIPEND_MAX_PER_PAYMENT, USDC_DECIMALS),
      windowCapAtomic: toAtomic(e.STIPEND_WINDOW_CAP, USDC_DECIMALS),
      windowMs: e.STIPEND_WINDOW_HOURS * 60 * 60 * 1000,
    },
  };
}
