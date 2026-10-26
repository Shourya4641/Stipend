import express from "express";
import type { x402Facilitator } from "@x402/core/facilitator";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { classify, classifyPass } from "../shared/classify";
import { deadlineOf, attemptId, amountOf, facilitatorRequestSchema } from "./wire";
import { decide, DEFAULT_POLICY, type PolicyConfig } from "./policy";
import { withBody, errorHandler } from "../shared/http";
import { UpstreamError } from "../shared/errors";
import { paymentIdentity } from "./message-hash";
import { fingerprint } from "./db/fingerprint";
import { DuplicatePayment, type Ledger } from "./db/ledger";
import { silentLogger, type Logger } from "../shared/logger";

/**
 * What the routes need from the SDK — an interface, not the concrete class.
 *
 * `x402Facilitator` satisfies this structurally with no changes to it, and a
 * test can pass a three-line stub returning any outcome it wants to
 * exercise: settlement_pending, a throw, an invalid verify. None of those
 * can be provoked reliably against devnet.
 */
export type FacilitatorCore = Pick<x402Facilitator, "verify" | "settle" | "getSupported"> & {
  onBeforeSettle: x402Facilitator["onBeforeSettle"];
};

/** Only the chain call the routes actually make. */
export type ChainReader = { getBlockHeight(): Promise<bigint> };

export type FacilitatorDeps = {
  facilitator: FacilitatorCore;
  chain: ChainReader;
  /** The spend policy. Explicit so a test can set a cap it controls. */
  policy?: PolicyConfig;
  /** Defaults to silent: route tests assert on responses, not noise. */
  logger?: Logger;
  /**
   * Durable record of every settlement.
   *
   * REQUIRED, not optional: settling with no record is the exact failure
   * the ledger exists to prevent, so a facilitator without one must not
   * run. The cost is availability — Postgres down means payments refused
   * rather than payments unrecorded. That is the right trade for money and
   * it belongs in the README.
   */
  ledger: Ledger;
};

/**
 * Builds the app. Never listens — the entrypoint does that (D5).
 *
 * A seam, not a layer. Nothing here is constructed at import time, which is
 * what lets supertest drive these routes with a fake chain and a stub
 * facilitator.
 */
export function createApp(deps: FacilitatorDeps): express.Express {
  const { facilitator, chain, ledger, policy = DEFAULT_POLICY, logger = silentLogger() } = deps;

  // Defence in depth only. The route decides BEFORE calling settle (below),
  // so nothing depends on catching this hook's exception any more — which is
  // how a policy decision came to be disguised as an error in the first
  // place (D4). The hook still fires if the SDK is driven from elsewhere.
  facilitator.onBeforeSettle(async ({ requirements }) => {
    const decision = decide(amountOf(requirements), policy);
    if (decision.allowed) return;
    return { abort: true, reason: decision.reason };
  });

  const app = express();
  app.use(express.json());

  app.get("/supported", (_req, res) => {
    const all = facilitator.getSupported();
    // registerExactSvmScheme also registers v1 shims, which fan out to
    // mainnet and testnet names we never asked for. Advertise only what we
    // can actually settle.
    res.json({
      ...all,
      kinds: all.kinds.filter((k) => k.network === SOLANA_DEVNET_CAIP2),
    });
  });

  app.post(
    "/verify",
    withBody(facilitatorRequestSchema, async (_req, res, body) => {
      const { paymentPayload, paymentRequirements } = body;
      const id = attemptId(paymentPayload);
      // Bound once. Every line this request produces carries attemptId,
      // which is what makes verify and settle a JOIN rather than two
      // lines that happen to look alike.
      const log = logger.child({ attemptId: id });

      // ── ANSWER: valid or not. Either way the SDK RETURNS.
      //
      // Verify never broadcasts, so there is never a signature here, and
      // classify decides on arithmetic alone: past the deadline -> expired
      // and safe to re-sign; inside it -> rejected on the merits.
      //
      // KNOWN LIMIT: "AlreadyProcessed" lands in rejected — the SAFE answer
      // (do not retry) but not the TRUE one (the money already moved).
      // Telling those apart needs a ledger keyed by request (D10).
      // Tell the handler WHICH END broke. Without this an SDK failure is
      // anonymous and answers 500 — "we have a bug" — when the truth is
      // "our dependency is down and your request was fine".
      const result = await facilitator
        .verify(paymentPayload, paymentRequirements)
        .catch((e: unknown) => {
          throw new UpstreamError("facilitator verify failed", e);
        });

      const verdict = result.isValid
        ? classifyPass("verify")
        : classify({
            phase: "verify",
            ok: false,
            signature: "",
            errorText: result.invalidMessage ?? result.invalidReason,
            lastValidBlockHeight: deadlineOf(paymentRequirements),
            currentBlockHeight: await chain.getBlockHeight(),
            refusalKind: "terms",
          });

      log.info(
        {
          phase: "verify",
          isValid: result.isValid,
          invalidReason: result.invalidReason,
          state: verdict.state,
        },
        result.isValid ? "verified" : "verification refused",
      );

      res.json({ ...result, extra: { ...result.extra, stipend: verdict } });

      // ── ACCIDENT: no catch. A throw here is our dependency failing, and
      //    the global handler answers 502 — the request was fine, we were
      //    not, and the status says which end broke.
    }),
  );

  app.post(
    "/settle",
    withBody(facilitatorRequestSchema, async (_req, res, body) => {
      const { paymentPayload, paymentRequirements } = body;
      const id = attemptId(paymentPayload);
      const log = logger.child({ attemptId: id });
      const lastValidBlockHeight = deadlineOf(paymentRequirements);

      const reply = async (args: {
        ok: boolean;
        signature: string;
        refusalKind?: "policy" | "terms" | undefined;
        errorText?: string | undefined;
        base: Record<string, unknown>;
      }) => {
        const verdict = classify({
          phase: "settle",
          ok: args.ok,
          signature: args.signature,
          errorText: args.errorText,
          lastValidBlockHeight,
          currentBlockHeight: await chain.getBlockHeight(),
          refusalKind: args.refusalKind,
        });
        // Fields, not a sentence: the ledger will key on exactly these.
        log.info(
          {
            phase: "settle",
            state: verdict.state,
            resignable: verdict.resignable,
            retryableLater: verdict.retryableLater,
            // Truncated: a broadcast signature is public, but the full
            // string is already in msg and 88 chars twice per line is
            // noise. 12 is enough to find it on an explorer.
            signature: args.signature ? args.signature.slice(0, 12) : undefined,
          },
          verdict.reason,
        );
        res.json({ ...args.base, extra: { ...(args.base["extra"] ?? {}), stipend: verdict } });
        // Returned so the caller can persist it. The route needs to know
        // WHAT it answered in order to record the same thing.
        return verdict;
      };

      // ── ANSWER: policy says no. A branch, not an exception.
      //    refusalKind comes from the decision itself, three lines above the
      //    use — there is nothing stored in between that another request
      //    could overwrite. That is why policyVeto is deleted, not fixed.
      const decision = decide(amountOf(paymentRequirements), policy);
      log.debug({ amount: paymentRequirements.amount, asset: paymentRequirements.asset }, "policy check");
      if (!decision.allowed) {
        // warn, not error: expected behaviour, but notable.
        log.warn({ reason: decision.reason }, "policy veto");
        await reply({
          ok: false,
          signature: "",
          refusalKind: "policy",
          errorText: decision.reason,
          base: {
            success: false,
            errorReason: "policy_abort",
            errorMessage: decision.reason,
            transaction: "",
            network: paymentRequirements.network,
          },
        });
        // MUST return. Without it the handler falls through to
        // recordIntent and settle, and a payment the policy refused is
        // broadcast anyway — the cap becomes decorative.
        return;
      }

      // ── THE ORDERING RULE: the row exists BEFORE anything is broadcast.
      //
      // Keyed on the message hash, because a txid is the fee payer's
      // signature and the SDK produces that inside settle() — at the same
      // moment it broadcasts. By then it is too late to record intent.
      const { messageHash: hash, payer } = paymentIdentity(
        String(paymentPayload.payload["transaction"]),
        String(paymentRequirements.extra?.["feePayer"] ?? ""),
      );

      let row;
      try {
        row = await ledger.recordIntent({
          paymentId: undefined, // D10 supplies this
          requestFingerprint: fingerprint({
            scheme: paymentRequirements.scheme,
            network: paymentRequirements.network,
            asset: paymentRequirements.asset,
            amount: paymentRequirements.amount,
            payTo: paymentRequirements.payTo,
          }),
          payer,
          network: paymentRequirements.network,
          asset: paymentRequirements.asset,
          payTo: paymentRequirements.payTo,
          amount: amountOf(paymentRequirements),
          resourceUrl: String((paymentPayload as { resource?: { url?: string } }).resource?.url ?? "") || undefined,
          messageHash: hash,
          signedTx: String(paymentPayload.payload["transaction"]),
          lastValidBlockHeight,
        });
      } catch (err) {
        // ── ANSWER: this purchase already settled. Return the original
        //    outcome rather than refusing — a client whose response was
        //    lost has paid and deserves its receipt. The signature is
        //    public on-chain anyway.
        //
        //    `replay: true` so the MERCHANT decides whether to release the
        //    resource again; that call is not ours (D10, and x402 PR #3021
        //    removed a settled-nonce path for exactly this reason).
        if (err instanceof DuplicatePayment) {
          log.warn({ state: err.existing.state }, "replay of a settled payment");
          await reply({
            ok: err.existing.state === "confirmed",
            signature: err.existing.txSignature ?? "",
            errorText: `already settled (${err.existing.state})`,
            base: {
              success: err.existing.state === "confirmed",
              transaction: err.existing.txSignature ?? "",
              network: paymentRequirements.network,
              extra: { replay: true },
            },
          });
          return;
        }
        // Postgres is down. An ACCIDENT, not a payment outcome: 502, no
        // verdict, and critically NOTHING WAS BROADCAST.
        throw new UpstreamError("ledger write failed", err);
      }

      // ── ANSWER: the SDK settled, or did not. Either way it RETURNED.
      const result = await facilitator
        .settle(paymentPayload, paymentRequirements)
        .catch((e: unknown) => {
          throw new UpstreamError("facilitator settle failed", e);
        });

      const verdict = await reply({
        ok: result.success,
        signature: result.transaction,
        refusalKind: result.transaction ? undefined : "terms",
        errorText: result.errorMessage ?? result.errorReason,
        base: { ...result },
      });

      // Record the outcome. `pending` stays pending for the reconciler.
      if (verdict && verdict.state !== "pending") {
        await ledger.resolve(row.id, verdict.state as never, {
          txSignature: result.transaction || undefined,
        });
      } else if (result.transaction) {
        // Pending, but it WAS broadcast — store the signature so the
        // reconciler has something to ask the chain about.
        await ledger.noteBroadcast(row.id, result.transaction);
      }
      return;

      // ── ACCIDENT: no catch. Both answers are returns above, so anything
      //    thrown here is infrastructure or a bug. Express 5 forwards the
      //    rejection to the error middleware for us.
    }),
  );

  // Registered LAST, after every route.
  app.use(errorHandler(logger));

  return app;
}
