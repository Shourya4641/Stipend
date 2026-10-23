import { toAtomic, type AtomicAmount } from "../shared/amount";
import { USDC_DECIMALS } from "../shared/chain-constants";
/**
 * Stipend's spend policy — the reason this project exists.
 *
 * Separate from the server because it is the only part a user of Stipend
 * would ever configure, and because it is the ONLY place in the system that
 * knows a refusal was a policy veto rather than a malformed payment. Both
 * reach the merchant as success:false, so that distinction has to be carried
 * deliberately rather than recovered from an error message later.
 *
 * Pure and synchronous today. When the Postgres ledger lands this becomes
 * async and takes a payment key, which is also what removes the single-flight
 * limitation below.
 */

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type PolicyConfig = {
  /** Per-payment cap in atomic token units. 10_000 = 0.01 USDC at 6 decimals. */
  maxAtomicPerPayment: AtomicAmount;
};

export const DEFAULT_POLICY: PolicyConfig = {
  maxAtomicPerPayment: toAtomic(10_000n, USDC_DECIMALS),
};

/**
 * Decide a single payment against the policy.
 *
 * Takes the amount already parsed, so this stays testable without a chain,
 * a server or a request.
 */
//! Understanding question - Why are we setting the config this way here .. looks like over engineered stuff?
export function decide(amountAtomic: AtomicAmount, config: PolicyConfig): PolicyDecision {
  // Only zero needs checking here: toAtomic refuses negatives at
  // construction, so an AtomicAmount cannot be negative. The type did the
  // other half of this guard.
  if (amountAtomic === 0n) {
    return { allowed: false, reason: "zero amount" };
  }
  if (amountAtomic > config.maxAtomicPerPayment) {
    return {
      allowed: false,
      reason: `per-payment cap ${config.maxAtomicPerPayment} exceeded by ${amountAtomic}`,
    };
  }
  return { allowed: true };
}
