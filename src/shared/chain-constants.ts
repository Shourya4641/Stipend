/**
 * Protocol truths, not configuration (D3).
 *
 * Deliberately NOT env-overridable. `process.env.DEVNET_USDC_MINT` would
 * invite pointing a devnet build at an arbitrary mint with nothing
 * downstream noticing.
 */

/**
 * Devnet USDC. Verified on-chain in Stage 1: 6 decimals, owned by the
 * CLASSIC SPL Token program, not Token-2022.
 */
export const USDC_MINT_ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** USDC has 6 decimals. 10_000 atomic units = 0.01 USDC. */
export const USDC_DECIMALS = 6;

/**
 * A Solana blockhash is valid for ~150 slots at ~400ms, so roughly a minute.
 * The merchant's maxTimeoutSeconds is coupled to this whether we intend it
 * or not: a lower value abandons payments that could still land.
 */
export const BLOCKHASH_VALIDITY_SECONDS = 60;
