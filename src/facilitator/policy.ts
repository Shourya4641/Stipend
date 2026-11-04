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
  /** Refuses one oversized payment. NOT a spend limit on its own. */
  maxAtomicPerPayment: AtomicAmount;
  /** Total allowed across a rolling window. THIS is the spend limit. */
  windowCapAtomic: AtomicAmount;
  /** Length of that rolling window, in milliseconds. */
  windowMs: number;
};

export const DEFAULT_POLICY: PolicyConfig = {
  maxAtomicPerPayment: toAtomic(10_000n, USDC_DECIMALS),
  windowCapAtomic: toAtomic(50_000n, USDC_DECIMALS), // 0.05 USDC
  windowMs: 10 * 60 * 1000, // ten minutes — see STIPEND_WINDOW_MINUTES
};

/**
 * Decide a single payment against the policy.
 *
 * Takes the amount already parsed, so this stays testable without a chain,
 * a server or a request.
 */
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

/**
 * The cumulative check — the one that makes this a spend limit.
 *
 * A per-payment cap is not a budget: an agent capped at 0.01 USDC per
 * payment can spend without bound by paying a thousand times. Only a total
 * across a window bounds what an agent can lose.
 *
 * Pure, like decide(): the caller supplies `spentInWindow` from the ledger.
 * Keeping the IO outside means this is testable with no database, and the
 * route logs the decision rather than this function doing it (D2).
 *
 * NOT ATOMIC under concurrency. Two payments arriving together can both
 * read the same `spentInWindow`, both pass, and together exceed the cap by
 * up to one payment's worth — which maxAtomicPerPayment bounds. Closing it
 * properly needs the read and the insert in one transaction with the
 * payer's rows locked. Documented rather than hidden; the per-payment cap
 * is what keeps the overshoot small.
 */
export function decideWindow(
  amountAtomic: AtomicAmount,
  spentInWindow: bigint,
  config: PolicyConfig,
): PolicyDecision {
  const total = spentInWindow + amountAtomic;
  if (total > config.windowCapAtomic) {
    return {
      allowed: false,
      reason:
        `window cap ${config.windowCapAtomic} exceeded: ` +
        `${spentInWindow} already spent, ${amountAtomic} requested`,
    };
  }
  return { allowed: true };
}
