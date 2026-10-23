import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

// No FACILITATOR_URL and no port: the agent talks only to the merchant and
// listens on nothing.
const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  MERCHANT_URL: z.string().url().default(DEFAULTS.MERCHANT_URL),

  /**
   * How many times the agent may pay again after a resignable refusal.
   *
   * Explicit because the old code retried once by accident — written as a
   * single `if`, with no counter and nothing limiting it. For a
   * spend-limited wallet an unbounded retry path is the wrong default even
   * while the code happens to be bounded.
   */
  AGENT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
});

export type AgentConfig = { chain: ChainConfig; merchantUrl: string; maxRetries: number };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const e = parseEnv("agent", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    merchantUrl: e.MERCHANT_URL,
    maxRetries: e.AGENT_MAX_RETRIES,
  };
}
