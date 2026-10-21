/**
 * Single source for values that would otherwise be repeated string literals
 * across four processes. Nothing here reaches the network — see chain.ts.
 */
export const CONSTANTS = {
  KEY_DIR: ".keys",

  /** Public devnet allows getProgramAccounts; some providers' free tiers don't. */
  RPC_URL: process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com",

  /**
   * Devnet USDC. Verified on-chain in Stage 1: 6 decimals, owned by the
   * CLASSIC SPL Token program, not Token-2022.
   */
  USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",

  MERCHANT_URL: process.env.MERCHANT_URL ?? "http://127.0.0.1:4021",
  FACILITATOR_URL: process.env.FACILITATOR_URL ?? "http://127.0.0.1:3000",
  MERCHANT_PORT: Number(process.env.MERCHANT_PORT ?? 4021),
  FACILITATOR_PORT: Number(process.env.FACILITATOR_PORT ?? 3000),
} as const;
