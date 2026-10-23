import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  MERCHANT_PORT: z.coerce.number().int().positive().default(DEFAULTS.MERCHANT_PORT),
  FACILITATOR_URL: z.string().url().default(DEFAULTS.FACILITATOR_URL),
});

export type MerchantConfig = {
  chain: ChainConfig;
  port: number;
  facilitatorUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MerchantConfig {
  const e = parseEnv("merchant", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    port: e.MERCHANT_PORT,
    facilitatorUrl: e.FACILITATOR_URL,
  };
}
