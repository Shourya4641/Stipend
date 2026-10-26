import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

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
});

export type FacilitatorConfig = {
  chain: ChainConfig;
  port: number;
  databaseUrl: string;
};

/** Called ONCE by the entrypoint. Never at import time (D3). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const e = parseEnv("facilitator", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    port: e.FACILITATOR_PORT,
    databaseUrl: e.DATABASE_URL,
  };
}
