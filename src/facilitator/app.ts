import express from "express";
import type { x402Facilitator } from "@x402/core/facilitator";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { classify, classifyPass } from "../shared/classify";
import { deadlineOf, attemptId, amountOf, facilitatorRequestSchema } from "./wire";
import { decide, decideWindow, DEFAULT_POLICY, type PolicyConfig } from "./policy";
import { withBody, errorHandler, paymentRateLimit } from "../shared/http";
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
  /**
   * The spend policy. REQUIRED, with no default.
   *
   * It was optional, and server.ts silently never passed it — so the
   * configured cap was computed, dropped, and DEFAULT_POLICY enforced
   * instead. Four devnet payments sailed past a 2500 cap before anyone
   * noticed. A default on a money limit hides exactly this.
   */
  policy: PolicyConfig;
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
  /**
   * This facilitator's own fee-payer address.
   *
   * NOT read from paymentRequirements.extra: that is merchant-supplied,
   * and if it is absent the payer resolves to the fee payer itself — so
   * spentSince queries an address no agent uses and the cap silently
   * enforces nothing. We loaded this keypair; we know it.
   */
  feePayer: string;
};

/**
 * Builds the app. Never listens — the entrypoint does that (D5).
 *
 * A seam, not a layer. Nothing here is constructed at import time, which is
 * what lets supertest drive these routes with a fake chain and a stub
 * facilitator.
 */
export function createApp(deps: FacilitatorDeps): express.Express {
  const { facilitator, chain, ledger, feePayer, policy, logger = silentLogger() } = deps;

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
  // Railway and Cloudflare both front the app, so without this every
  // request carries the proxy's IP and the rate limit treats the entire
  // internet as one client.
  app.set("trust proxy", 1);
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
    // Before the body is parsed, so a flood costs us nothing but a 429.
    paymentRateLimit(),
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

      // Decoded FIRST, because the cumulative cap needs to know who is
      // paying and only the transaction can say. The payload has no payer
      // field, and a self-declared one could name someone else's address
      // to spend against their budget.
      const { messageHash: hash, payer } = paymentIdentity(
        String(paymentPayload.payload["transaction"]),
        feePayer,
      );
      const amount = amountOf(paymentRequirements);

      /** Both caps refuse the same way. One shape, two callers. */
      const refuse = async (reason: string) => {
        log.warn({ reason }, "policy veto");
        await reply({
          ok: false,
          signature: "",
          refusalKind: "policy",
          errorText: reason,
          base: {
            success: false,
            errorReason: "policy_abort",
            errorMessage: reason,
            transaction: "",
            network: paymentRequirements.network,
          },
        });
      };

      // ── ANSWER: policy says no. A branch, not an exception.
      //    refusalKind comes from the decision itself, three lines above the
      //    use — there is nothing stored in between that another request
      //    could overwrite. That is why policyVeto is deleted, not fixed.
      const decision = decide(amount, policy);
      log.debug({ amount: paymentRequirements.amount, payer }, "policy check");
      if (!decision.allowed) {
        // MUST return. Without it the handler falls through to recordIntent
        // and settle, and a payment the policy refused is broadcast anyway
        // — the cap becomes decorative. (This fell through once; a test
        // asserting on what the route DID, not what it returned, caught it.)
        await refuse(decision.reason);
        return;
      }

      // ── ANSWER: the BUDGET says no. The cap the project is named for.
      //
      // A per-payment cap is not a spend limit: an agent capped at 0.01
      // USDC per payment can spend without bound by paying a thousand
      // times. Only a total across a window bounds what an agent can lose.
      //
      // spentSince counts PENDING as spent, deliberately — a pending
      // payment might have landed, and a limit that ignores "might have"
      // is one a crash-and-retry cycle walks straight through. The cost is
      // that the reconciler is what RELEASES budget, not just bookkeeping.
      //
      // NOT ATOMIC: two payments arriving together can read the same total
      // and both pass, overshooting by at most one payment — which the
      // per-payment cap bounds. Closing it needs the read and the insert in
      // one transaction with this payer's rows locked.
      const windowStart = new Date(Date.now() - policy.windowMs);
      const spent = await ledger
        .spentSince(payer, windowStart)
        .catch((e: unknown) => {
          // Cannot prove the agent is within budget, so do not pay. Fail
          // closed: an unenforced cap is worse than a refused payment.
          throw new UpstreamError("ledger read failed", e);
        });

      const windowDecision = decideWindow(amount, spent, policy);
      log.debug({ spent, cap: policy.windowCapAtomic, payer }, "window check");
      if (!windowDecision.allowed) {
        await refuse(windowDecision.reason);
        return;
      }

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
          amount,
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

  /**
   * Read-only views of the ledger, for the dashboard.
   *
   * On the facilitator rather than a separate service: the ledger already
   * answers these, and a fourth role would need its own DATABASE_URL and
   * an exception in the boundary test. The dashboard stays static files.
   *
   * Public, deliberately. Every row describes a devnet payment that is
   * already visible on-chain, so this is transparency rather than
   * disclosure. On mainnet it would need an API key.
   */
  app.get("/settlements", async (_req, res, next) => {
    try {
      const rows = await ledger.recent(50);
      // bigint and Date do not survive JSON.stringify and res.json: the
      // first throws, the second silently becomes a string of whatever
      // shape the driver chose. Both are converted here, once, so the
      // dashboard never has to guess.
      res.json({
        settlements: rows.map((r) => ({
          id: r.id.toString(),
          state: r.state,
          payer: r.payer,
          amount: r.amount.toString(),
          asset: r.asset,
          resourceUrl: r.resourceUrl,
          messageHash: r.messageHash,
          txSignature: r.txSignature,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(new UpstreamError("could not read the ledger", err));
    }
  });

  /**
   * What the dashboard shows BEFORE enabling the pay button.
   *
   * A judge arriving after someone else exhausted the window would
   * otherwise see a dead button and no reason. Stating the budget makes
   * the spend limit legible without spending anything — the feature
   * explains itself even when it is blocking.
   */
  app.get("/window/:payer", async (req, res, next) => {
    try {
      const payer = String(req.params["payer"]);
      const since = new Date(Date.now() - policy.windowMs);
      const status = await ledger.windowStatus(payer, since);
      const remaining = policy.windowCapAtomic - status.spent;

      res.json({
        payer,
        windowMs: policy.windowMs,
        cap: policy.windowCapAtomic.toString(),
        spent: status.spent.toString(),
        remaining: (remaining > 0n ? remaining : 0n).toString(),
        payments: status.count,
        exhausted: remaining < policy.maxAtomicPerPayment,
        // When the EARLIEST payment leaves the window, so some budget
        // returns. Not a full reset: the window rolls, so capacity comes
        // back in slices.
        nextReleaseAt: status.oldestAt
          ? new Date(status.oldestAt.getTime() + policy.windowMs).toISOString()
          : null,
      });
    } catch (err) {
      next(new UpstreamError("could not read the window", err));
    }
  });

  // Registered LAST, after every route.
  app.use(errorHandler(logger));

  return app;
}
