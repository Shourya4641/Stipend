import express from "express";
import type { x402Facilitator } from "@x402/core/facilitator";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { classify, classifyPass } from "../shared/classify";
import { deadlineOf, attemptId, amountOf, facilitatorRequestSchema } from "./wire";
import { decide, DEFAULT_POLICY, type PolicyConfig } from "./policy";
import { withBody, errorHandler } from "../shared/http";
import { UpstreamError } from "../shared/errors";
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
};

/**
 * Builds the app. Never listens — the entrypoint does that (D5).
 *
 * A seam, not a layer. Nothing here is constructed at import time, which is
 * what lets supertest drive these routes with a fake chain and a stub
 * facilitator.
 */
export function createApp(deps: FacilitatorDeps): express.Express {
  const { facilitator, chain, policy = DEFAULT_POLICY, logger = silentLogger() } = deps;

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
        return reply({
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
      }

      // ── ANSWER: the SDK settled, or did not. Either way it RETURNED.
      const result = await facilitator
        .settle(paymentPayload, paymentRequirements)
        .catch((e: unknown) => {
          throw new UpstreamError("facilitator settle failed", e);
        });
      return reply({
        ok: result.success,
        signature: result.transaction,
        refusalKind: result.transaction ? undefined : "terms",
        errorText: result.errorMessage ?? result.errorReason,
        base: { ...result },
      });

      // ── ACCIDENT: no catch. Both answers are returns above, so anything
      //    thrown here is infrastructure or a bug. Express 5 forwards the
      //    rejection to the error middleware for us.
    }),
  );

  // Registered LAST, after every route.
  app.use(errorHandler(logger));

  return app;
}
