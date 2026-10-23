import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

// No FACILITATOR_URL and no port: the agent talks only to the merchant and
// listens on nothing.
const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  MERCHANT_URL: z.string().url().default(DEFAULTS.MERCHANT_URL),
});

export type AgentConfig = { chain: ChainConfig; merchantUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const e = parseEnv("agent", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    merchantUrl: e.MERCHANT_URL,
  };
}
