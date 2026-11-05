/**
 * One payment attempt, with self-diagnosis and bounded retry.
 *
 * Extracted from client.ts so the CLI and the hosted demo run the SAME
 * code. A demo that reimplements the agent is a demo that can diverge
 * from the thing it claims to show.
 *
 * A factory taking its dependencies (D15): nothing is constructed at
 * import time, so this is usable from a long-running server rather than
 * only from a script.
 */
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import type { TransactionSigner } from "@solana/kit";
import { classify } from "../shared/classify";
import { Phase, SettlementState } from "../shared/enums";

export type PayerDeps = {
  /** ACCEPTED, never created — the library does not mint wallets (D13). */
  signer: TransactionSigner;
  chain: { getBlockHeight(): Promise<bigint> };
  /** Payments after a resignable refusal. 0 disables retry. */
  maxRetries: number;
};

/** One line of what happened, for a log or a web page. */
export type AttemptRecord = {
  attempt: number;
  status: number;
  /** The facilitator's verdict, when it reached us. */
  stipend?: Record<string, unknown> | undefined;
  /** The agent's OWN diagnosis when no verdict arrived. */
  diagnosis?: { state: string; resignable: boolean; reason: string } | undefined;
};

export type PayResult = {
  ok: boolean;
  status: number;
  attempts: AttemptRecord[];
  /** The resource, once paid for. */
  body: unknown;
  payer: string;
};

export function createPayer(deps: PayerDeps) {
  const client = new x402Client();
  registerExactSvmScheme(client, { signer: toClientSvmSigner(deps.signer) });

  /**
   * The deadline of the challenge we actually signed against.
   *
   * A failed payment gets a FRESH 402 with a new blockhash, so diagnosing
   * from the response would compare against a deadline we never used and
   * nothing would ever look expired. This hook fires during selection —
   * after the 402 arrives, before signing — which is the only moment the
   * right value is visible.
   */
  let observedDeadline: bigint | undefined;
  client.registerPolicy((_version, requirements) => {
    const d = requirements[0]?.extra?.["lastValidBlockHeight"];
    observedDeadline = d === undefined ? undefined : BigInt(String(d));
    return requirements;
  });

  const payFetch = wrapFetchWithPayment(fetch, client);

  const decodeHeader = (res: Response, name: string): Record<string, unknown> | undefined => {
    const v = res.headers.get(name);
    if (!v) return undefined;
    try {
      return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  };

  return async function pay(url: string): Promise<PayResult> {
    const attempts: AttemptRecord[] = [];
    let n = 1;

    // Cleared before and snapshotted immediately after: a module-level
    // value would let concurrent requests clobber each other between
    // signing and diagnosis.
    observedDeadline = undefined;
    let res = await payFetch(url);
    let deadline = observedDeadline;
    let settlement = decodeHeader(res, "payment-response");
    attempts.push({ attempt: n, status: res.status, stipend: settlement?.["extra"] as never });

    /**
     * A 402 with no PAYMENT-RESPONSE means the payment died at VERIFY:
     * nothing was broadcast, and the merchant drops the verdict, so we
     * get no report. We do not need one — the 402 gave us the deadline
     * and the chain gives us the height.
     *
     * This runs the SAME classify the facilitator runs, in a different
     * process, on the same inputs. One module, two callers, so they
     * cannot drift — and we trust nobody's account of whether our own
     * payment died.
     */
    while (res.status === 402 && !settlement && deadline !== undefined && n <= deps.maxRetries) {
      let currentBlockHeight: bigint;
      try {
        currentBlockHeight = await deps.chain.getBlockHeight();
      } catch {
        // UNKNOWN IS NEVER RESIGNABLE. Without a height we cannot prove
        // the payment expired, and guessing risks paying twice.
        attempts[attempts.length - 1]!.diagnosis = {
          state: "unknown",
          resignable: false,
          reason: "the chain is unreachable, so expiry cannot be proven",
        };
        break;
      }

      const verdict = classify({
        phase: Phase.Verify,
        ok: false,
        signature: "",
        lastValidBlockHeight: deadline,
        currentBlockHeight,
      });
      attempts[attempts.length - 1]!.diagnosis = {
        state: verdict.state,
        resignable: verdict.resignable,
        reason: verdict.reason,
      };

      // Safe ONLY because nothing was broadcast: past its deadline a
      // Solana transaction is permanently dead, so the original cannot
      // land late and this is one payment, not two.
      if (!verdict.resignable || verdict.state !== SettlementState.Expired) break;

      n += 1;
      observedDeadline = undefined;
      res = await payFetch(url);
      deadline = observedDeadline;
      settlement = decodeHeader(res, "payment-response");
      attempts.push({ attempt: n, status: res.status, stipend: settlement?.["extra"] as never });
    }

    const text = await res.text();
    return {
      ok: res.status === 200,
      status: res.status,
      attempts,
      body: (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })(),
      payer: deps.signer.address,
    };
  };
}
