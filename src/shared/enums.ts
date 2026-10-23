/**
 * Vocabulary that crosses role boundaries (D1).
 *
 * `as const` objects, not the `enum` keyword. A TypeScript string enum is
 * NOMINALLY typed: a plain `string` from @x402/core is not assignable to an
 * enum member without a cast, and this code reads strings off the wire
 * constantly — network, scheme, invalidReason, errorReason. Every boundary
 * would need a cast, which is exactly what D6 removes.
 *
 * This pattern gives autocomplete, a usable type, Object.values() for tests,
 * and direct comparison with SDK strings. `const enum` is already impossible
 * here: isolatedModules forbids it.
 *
 * Values used by ONE role live in that role's own folder, not here.
 */

/**
 * The settlement state machine.
 *
 * The whole of the "sensible handling of failed payments" story lives in the
 * distinction between Expired, Pending and Failed. Collapsing them is the
 * bug that makes a buyer pay for work that gets thrown away.
 *
 *   Rejected  — never submitted. Policy said no, or verification said no.
 *   Expired   — the blockhash aged out before submission. Nothing was signed
 *               onto the chain. Safe to authorise a fresh payment.
 *   Pending   — submitted, outcome unknown. NEVER safe to re-sign.
 *   Confirmed — landed and succeeded.
 *   Failed    — landed and the transaction itself errored.
 */
export const SettlementState = {
  Rejected: "rejected",
  Expired: "expired",
  Pending: "pending",
  Confirmed: "confirmed",
  Failed: "failed",
} as const;
export type SettlementState = (typeof SettlementState)[keyof typeof SettlementState];

export const SETTLEMENT_STATES = Object.values(SettlementState);

/** States from which a payer may safely build and sign a NEW payment. */
export const RESIGNABLE_STATES: readonly SettlementState[] = [
  SettlementState.Rejected,
  SettlementState.Expired,
];

/** Which half of the protocol produced an outcome. */
export const Phase = {
  Verify: "verify",
  Settle: "settle",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/**
 * Why a refusal happened, supplied by WHOEVER REFUSED — never parsed from an
 * error message. The facilitator's policy knows it vetoed; the scheme knows
 * the transaction was malformed. Only they can say.
 */
export const RefusalKind = {
  /** A limit or gate that may lapse: spend cap, rate limit. */
  Policy: "policy",
  /** Wrong by construction: bad amount, missing account. */
  Terms: "terms",
  /** Unattributed. Treated as Terms — the safer default. */
  Unknown: "unknown",
} as const;
export type RefusalKind = (typeof RefusalKind)[keyof typeof RefusalKind];

/** The outcome of a check that PASSED. Deliberately not a SettlementState. */
export const PassState = {
  Verified: "verified",
  Settled: "settled",
} as const;
export type PassState = (typeof PassState)[keyof typeof PassState];
