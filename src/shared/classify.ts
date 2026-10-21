/**
 * Settlement classification: did this payment reach the chain, and is it
 * safe to sign a replacement?
 *
 * The question that decides everything is "was a signature broadcast",
 * not "what did the error say". Error text is a hint. A signature is a fact.
 */

export const SETTLEMENT_STATES = [
  "rejected",
  "expired",
  "pending",
  "confirmed",
  "failed",
] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

export type Classification = {
  state: SettlementState;
  /** May the payer build and sign a NEW payment for this request, NOW? */
  resignable: boolean;
  /**
   * The refusal may lapse on its own: identical terms could succeed later
   * with nothing changed. A spend cap that resets, a rate limit, a
   * temporarily unreachable dependency.
   *
   * Distinct from `resignable`, which asks "is it safe right now". A
   * payment can be retryableLater and not resignable: wait, then retry.
   */
  retryableLater: boolean;
  /** Why this classification was reached. Goes in the ledger and the logs. */
  reason: string;
};

export type ClassifyInput = {
  /** Which half of the protocol produced this outcome. */
  phase: "verify" | "settle";
  /** Did that call report success? */
  ok: boolean;
  /** Transaction signature. Present ONLY once bytes were broadcast. */
  signature?: string | undefined;
  /** invalidMessage (verify) or errorReason (settle). Advisory only. */
  errorText?: string | undefined;
  /** From the 402: extra.lastValidBlockHeight. */
  lastValidBlockHeight: bigint;
  /** Chain height observed at classification time. */
  currentBlockHeight: bigint;
  /**
   * Why a refusal happened, supplied by whoever refused — NOT parsed from
   * errorText. The facilitator's policy hook knows it vetoed; the scheme
   * knows the transaction was malformed. Only they can say.
   *
   *   "policy"  — a limit or gate that may lapse (spend cap, rate limit)
   *   "terms"   — wrong by construction (bad amount, missing account)
   *   "unknown" — unattributed; treated as "terms", the safer default
   */
  refusalKind?: "policy" | "terms" | "unknown" | undefined;
};

export function classify(input: ClassifyInput): Classification {
  const {
    phase,
    ok,
    signature,
    errorText,
    lastValidBlockHeight,
    currentBlockHeight,
    refusalKind,
  } = input;

  // SettleResponse.transaction is a REQUIRED string in @x402/core, so a
  // refusal that never broadcast arrives as "". Normalise here rather than
  // trusting every caller: an empty signature must never read as "broadcast".
  const sig = signature && signature.trim().length > 0 ? signature : undefined;

  const expiredByHeight = currentBlockHeight > lastValidBlockHeight;

  // ---- 1. Success, with proof. -------------------------------------------
  if (phase === "settle" && ok && sig) {
    return {
      state: "confirmed",
      resignable: false,
      retryableLater: false,
      reason: `settled: ${sig}`,
    };
  }

  // ---- 2. Success claimed with no signature. -----------------------------
  // A facilitator reporting success without a signature is misbehaving.
  // Treat it as broadcast-of-unknown-outcome rather than trusting it: the
  // expensive mistake is paying twice, not waiting.
  if (phase === "settle" && ok && !sig) {
    return {
      state: "pending",
      resignable: false,
      retryableLater: false,
      reason: "settle reported success with no signature; outcome unknown",
    };
  }

  // ---- 3. A signature exists. This dominates everything below. -----------
  // Bytes went to the chain. We cannot tell from here whether they landed:
  // the RPC may have failed while the transaction confirmed. The ONLY safe
  // move is to reconcile against the chain, never to re-sign.
  //
  // Deliberately placed above the expiry check: an expired-looking error
  // AFTER broadcast does not make re-signing safe.
  if (sig) {
    return {
      state: "pending",
      resignable: false,
      retryableLater: false,
      reason: `broadcast ${sig}, outcome unknown${errorText ? `: ${errorText}` : ""}`,
    };
  }

  // ---- 4. Nothing was broadcast. Expired? --------------------------------
  // Structural test, not a string match. Past lastValidBlockHeight a Solana
  // transaction is permanently dead — it cannot land late. So the payer may
  // safely authorise a fresh one.
  if (expiredByHeight) {
    return {
      state: "expired",
      resignable: true,
      retryableLater: false,
      reason: `chain at ${currentBlockHeight} is past lastValidBlockHeight ${lastValidBlockHeight}; nothing broadcast`,
    };
  }

  // ---- 5. Nothing broadcast, still within the window. --------------------
  // The payment was refused on its merits: wrong amount, missing account,
  // policy veto. Re-signing identical terms produces an identical refusal,
  // so do not retry automatically — surface it.
  // A policy refusal may lapse; a malformed payment never will. Unattributed
  // refusals are treated as terms — the safe default is "do not retry".
  return {
    state: "rejected",
    resignable: false,
    retryableLater: refusalKind === "policy",
    reason: `${phase} refused within the validity window (${refusalKind ?? "unknown"})${errorText ? `: ${errorText}` : ""}`,
  };
}

/**
 * Resolve a `pending` classification against the chain.
 *
 * `classify` is pure and never does I/O, so it can only ever say "pending".
 * Turning pending into confirmed or failed REQUIRES asking the chain, which
 * is a separate step by design: the two halves fail differently and should
 * be testable separately.
 */
export function resolvePending(
  signature: string,
  onChain: { landed: boolean; errored: boolean },
): Classification {
  if (!onChain.landed) {
    return {
      state: "pending",
      resignable: false,
      retryableLater: false,
      reason: `${signature} not found on chain yet`,
    };
  }
  return onChain.errored
    ? {
        state: "failed",
        resignable: false,
        retryableLater: false,
        reason: `${signature} landed and errored`,
      }
    : {
        state: "confirmed",
        resignable: false,
        retryableLater: false,
        reason: `${signature} landed`,
      };
}

/**
 * The outcome of a check that PASSED.
 *
 * Deliberately NOT a SettlementState. Nothing settled, nothing was refused,
 * nothing expired — "cleared to proceed" is a different question from "what
 * went wrong and is retrying safe", which is all `classify` answers.
 */
export type PassVerdict = {
  state: "verified" | "settled";
  signature?: string | undefined;
};

export function classifyPass(
  phase: "verify" | "settle",
  signature?: string,
): PassVerdict {
  return phase === "verify"
    ? { state: "verified" }
    : { state: "settled", signature };
}
