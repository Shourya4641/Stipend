import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";

const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  PORT: z.coerce.number().int().positive().optional(),
  DEMO_PORT: z.coerce.number().int().positive().default(4040),
  MERCHANT_URL: z.string().url().default(DEFAULTS.MERCHANT_URL),
  /** Where the page reads the ledger from. Public, so the browser can reach it. */
  FACILITATOR_PUBLIC_URL: z.string().url().default(DEFAULTS.FACILITATOR_URL),
  AGENT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
});

export type DemoConfig = {
  chain: ChainConfig;
  port: number;
  merchantUrl: string;
  facilitatorPublicUrl: string;
  maxRetries: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const e = parseEnv("demo", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    port: e.PORT ?? e.DEMO_PORT,
    merchantUrl: e.MERCHANT_URL,
    facilitatorPublicUrl: e.FACILITATOR_PUBLIC_URL,
    maxRetries: e.AGENT_MAX_RETRIES,
  };
}
