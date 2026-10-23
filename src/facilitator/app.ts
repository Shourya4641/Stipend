import express from "express";
import type { x402Facilitator } from "@x402/core/facilitator";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { classify, classifyPass } from "../shared/classify";
import { parseFacilitatorRequest, deadlineOf, WireError, attemptId, amountOf } from "./wire";
import { decide, DEFAULT_POLICY, type PolicyConfig } from "./policy";

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
};

/**
 * Builds the app. Never listens — the entrypoint does that (D5).
 *
 * A seam, not a layer. Nothing here is constructed at import time, which is
 * what lets supertest drive these routes with a fake chain and a stub
 * facilitator.
 */
export function createApp(deps: FacilitatorDeps): express.Express {
  const { facilitator, chain, policy = DEFAULT_POLICY } = deps;

  // Scoped to this app instance, not the module. Two concurrent settles can
  // still read each other's veto — that race is real and D4 deletes the
  // variable entirely by moving the decision into the route. Per-instance is
  // strictly better than per-module in the meantime, and gives tests
  // isolation.
  let policyVeto: string | undefined;

  //   @x402/core 2.28.0 -> facilitator/index.d.mts (FacilitatorBeforeSettleHook)
  facilitator.onBeforeSettle(async ({ requirements }) => {
    policyVeto = undefined;
    // amountOf states the decimals once, here, instead of every call site
    // doing BigInt() and hoping the units match the cap.
    const amount = amountOf(requirements);
    const decision = decide(amount, policy);

    // No id here: the hook sees requirements, not the payload. Correlate by
    // the [settle] line that follows it.
    console.log(`[policy] settle requested: ${amount} of ${requirements.asset}`);
    if (decision.allowed) return;

    policyVeto = decision.reason;
    console.log(`[policy] VETO: ${policyVeto}`);
    return { abort: true, reason: policyVeto };
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

  /**
   * A body we could not read is NOT a payment outcome. 400, no verdict.
   * Classifying it would tell the payer their terms were refused when in
   * fact we never understood the request.
   */
  function wireFailure(res: express.Response, err: unknown): boolean {
    if (!(err instanceof WireError)) return false;
    console.error(`[wire] malformed request: ${err.message}`);
    res.status(400).json({ error: "malformed_request", message: err.message });
    return true;
  }

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = parseFacilitatorRequest(req.body);
      const id = attemptId(paymentPayload);
      const result = await facilitator.verify(paymentPayload, paymentRequirements);

      // Verify never broadcasts, so there is never a signature here, and
      // classify decides on arithmetic alone: past the deadline -> expired
      // and safe to re-sign; inside it -> rejected on the merits.
      //
      // KNOWN LIMIT: "AlreadyProcessed" lands in `rejected`, the SAFE answer
      // (do not retry) but not the TRUE one (the money already moved).
      // Telling those apart needs a ledger keyed by request (D10).
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

      console.log(
        result.isValid
          ? `[verify ${id}] VALID`
          : `[verify ${id}] INVALID ${result.invalidReason ?? ""} ${result.invalidMessage ?? ""} -> ${verdict.state}`,
      );

      res.json({ ...result, extra: { ...result.extra, stipend: verdict } });
    } catch (err) {
      if (wireFailure(res, err)) return;
      console.error("[verify] threw:", err instanceof Error ? err.message : err);
      res.status(502).json({
        isValid: false,
        invalidReason: "facilitator_error",
        invalidMessage: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/settle", async (req, res) => {
    let parsed;
    try {
      parsed = parseFacilitatorRequest(req.body);
    } catch (err) {
      if (wireFailure(res, err)) return;
      throw err;
    }
    const { paymentPayload, paymentRequirements } = parsed;

    // Derived from the signed transaction, so /verify computed the same id
    // for this attempt without anything being passed between the two calls.
    const id = attemptId(paymentPayload);

    // One source for the deadline, shared by the returned and thrown paths.
    const lastValidBlockHeight = deadlineOf(paymentRequirements);

    const reply = async (args: {
      ok: boolean;
      signature: string;
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
        refusalKind: policyVeto ? "policy" : args.signature ? undefined : "terms",
      });
      console.log(
        `[settle ${id}] ${verdict.state} resignable=${verdict.resignable} ` +
          `retryableLater=${verdict.retryableLater} — ${verdict.reason}`,
      );
      res.json({
        ...args.base,
        extra: { ...(args.base["extra"] ?? {}), stipend: verdict },
      });
    };

    try {
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      // transaction is a REQUIRED string in @x402/core, so a refusal that
      // never broadcast arrives as "". classify normalises that.
      await reply({
        ok: result.success,
        signature: result.transaction,
        errorText: result.errorMessage ?? result.errorReason,
        base: { ...result },
      });
    } catch (err) {
      // A policy abort THROWS here (x402Facilitator.ts:418) rather than
      // returning success:false. It is a legitimate outcome, not a crash, and
      // must carry the same structured verdict as every other path, or
      // retryableLater is invisible exactly when it matters.
      console.error("[settle] threw:", err instanceof Error ? err.message : err);
      await reply({
        ok: false,
        signature: "",
        errorText: err instanceof Error ? err.message : String(err),
        base: {
          success: false,
          errorReason: policyVeto ? "policy_abort" : "settle_threw",
          errorMessage: err instanceof Error ? err.message : String(err),
          transaction: "",
          network: paymentRequirements["network"],
        },
      });
    }
  });

  return app;
}
