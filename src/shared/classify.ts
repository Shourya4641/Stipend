import {
  Phase,
  RefusalKind,
  SettlementState,
  PassState,
} from "./enums";

export { SETTLEMENT_STATES, RESIGNABLE_STATES } from "./enums";
//! Have a separate file for the storing the enums and types for all the different services.
/**
 * Settlement classification: did this payment reach the chain, and is it
 * safe to sign a replacement?
 *
 * The question that decides everything is "was a signature broadcast",
 * not "what did the error say". Error text is a hint. A signature is a fact.
 */

//! Use enums
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
  phase: Phase;
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
  refusalKind?: RefusalKind | undefined;
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

  //! Refusal from whom would return the signature as empty?
  // SettleResponse.transaction is a REQUIRED string in @x402/core, so a
  // refusal that never broadcast arrives as "". Normalise here rather than
  // trusting every caller: an empty signature must never read as "broadcast".
  const sig = signature && signature.trim().length > 0 ? signature : undefined;

  // Branches 1 and 2 require Settle; branch 3 requires a signature. So a
  // verify outcome can only reach Expired or Rejected — Confirmed, Pending
  // and Failed are unreachable by construction. Correct, but emergent:
  // nothing stated it. A programmer error, so it throws (D4 class 4).
  if (phase === Phase.Verify && sig) {
    throw new Error("invariant: verify never broadcasts, so it cannot carry a signature");
  }

  const expiredByHeight = currentBlockHeight > lastValidBlockHeight;

  // ---- 1. Success, with proof. -------------------------------------------
  if (phase === Phase.Settle && ok && sig) {
    return {
      state: SettlementState.Confirmed,
      resignable: false,
      retryableLater: false,
      reason: `settled: ${sig}`,
    };
  }

  // ---- 2. Success claimed with no signature. -----------------------------
  // A facilitator reporting success without a signature is misbehaving.
  // Treat it as broadcast-of-unknown-outcome rather than trusting it: the
  // expensive mistake is paying twice, not waiting.
  if (phase === Phase.Settle && ok && !sig) {
    return {
      state: SettlementState.Pending,
      resignable: false,
      retryableLater: false,
      reason: "settle reported success with no signature; outcome unknown",
    };
  }

  // ---- 3. A signature exists. This dominates everything below. -----------
  // Bytes went to the chain. We cannot tell from here whether they landed:
  // the RPC may have failed while the transaction confirmed. The ONLY safe
  // move is to reconcile against the chain, never to re-sign.  //! How are we reconciling and where are we reconciling?
  //
  // Deliberately placed above the expiry check: an expired-looking error
  // AFTER broadcast does not make re-signing safe.
  if (sig) {
    return {
      state: SettlementState.Pending,
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
      state: SettlementState.Expired,
      resignable: true,
      retryableLater: false,
      reason: `chain at ${currentBlockHeight} is past lastValidBlockHeight ${lastValidBlockHeight}; nothing broadcast`,
    };
  }

  // ---- 5. Nothing broadcast, still within the window. --------------------
  // The payment was refused on its merits: wrong amount, missing account,
  // policy veto. Re-signing identical terms produces an identical refusal,
  // so do not retry automatically — surface it.  //! What happens after it is surfaced? How are we handling post surfacing the scenario?
  // A policy refusal may lapse; a malformed payment never will. Unattributed
  // refusals are treated as terms — the safe default is "do not retry".
  return {
    state: SettlementState.Rejected,
    resignable: false,
    retryableLater: refusalKind === RefusalKind.Policy,
    reason: `${phase} refused within the validity window (${refusalKind ?? "unknown"})${errorText ? `: ${errorText}` : ""}`,
  };
}

//! This is only getting called in the test .. what other use does this have?
//! How are we getting the values of onChain parameter here? Are we making some on chain call for it?
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
      state: SettlementState.Pending,
      resignable: false,
      retryableLater: false,
      reason: `${signature} not found on chain yet`,
    };
  }
  return onChain.errored
    ? {
        state: SettlementState.Failed,
        resignable: false,
        retryableLater: false,
        reason: `${signature} landed and errored`,
      }
    : {
        state: SettlementState.Confirmed,
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
  state: PassState;
  signature?: string | undefined;
};

export function classifyPass(
  phase: Phase,
  signature?: string,
): PassVerdict {
  return phase === Phase.Verify
    ? { state: PassState.Verified }
    : { state: PassState.Settled, signature };
}
