import { z } from "zod";
import { parseEnv, DEFAULTS } from "../shared/env";
import type { ChainConfig } from "../shared/chain";
import { BLOCKHASH_VALIDITY_SECONDS } from "../shared/chain-constants";

const schema = z.object({
  SOLANA_RPC_DEVNET: z.string().url().default(DEFAULTS.RPC_URL),
  SOLANA_WS_DEVNET: z.string().url().default("wss://api.devnet.solana.com"),
  /**
   * Railway, Render and most PaaS assign the port through $PORT and route
   * traffic there. Listening on our own default instead means the health
   * check fails with nothing in the logs to explain it.
   *
   * PORT wins when present; MERCHANT_PORT stays for running two
   * services on one machine locally.
   */
  PORT: z.coerce.number().int().positive().optional(),
  MERCHANT_PORT: z.coerce.number().int().positive().default(DEFAULTS.MERCHANT_PORT),
  FACILITATOR_URL: z.string().url().default(DEFAULTS.FACILITATOR_URL),

  // A business decision, not a literal in a server file (D14). It changed
  // twice during testing, each time an edit-and-restart.
  /**
   * Where payment lands. An ADDRESS, not a key — the merchant holds nothing
   * it can spend with, and this makes that structural rather than
   * incidental (D13).
   */
  MERCHANT_PAY_TO: z.string().min(32, "a base58 Solana address"),

  MERCHANT_PRICE: z
    .string()
    .regex(/^\$\d+(\.\d+)?$/, 'must look like "$0.001" — note shells expand an unquoted $')
    .default("$0.001"),
});

export type MerchantConfig = {
  chain: ChainConfig;
  port: number;
  facilitatorUrl: string;
  payTo: string;
  price: string;
  /**
   * How long the merchant will wait for settlement. Coupled to Solana's
   * ~60 s blockhash window whether we intend it or not: lower means
   * abandoning payments that could still land (D14).
   */
  maxTimeoutSeconds: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MerchantConfig {
  const e = parseEnv("merchant", schema, env);
  return {
    chain: { rpcUrl: e.SOLANA_RPC_DEVNET, wsUrl: e.SOLANA_WS_DEVNET },
    port: e.PORT ?? e.MERCHANT_PORT,
    facilitatorUrl: e.FACILITATOR_URL,
    payTo: e.MERCHANT_PAY_TO,
    price: e.MERCHANT_PRICE,
    maxTimeoutSeconds: BLOCKHASH_VALIDITY_SECONDS,
  };
}
