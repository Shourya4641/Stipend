import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

/** Shared by the operator scripts and the devnet harnesses. */
const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  MERCHANT_URL: z.string().url().default(DEFAULTS.MERCHANT_URL),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  chain: ChainConfig;
  merchantUrl: string;
} {
  const e = parseEnv("tools", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    merchantUrl: e.MERCHANT_URL,
  };
}
