import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "./keys";
import { classify } from "./classify";
import { getBlockHeight } from "./chain";

const PORT = Number(process.env.FACILITATOR_PORT ?? 3000);
const RPC_URL =
  process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";

// The ONLY wallet in Stipend that holds SOL. It never holds USDC and never
// moves the agent's money — it occupies the fee-payer slot and signs for that
// slot alone.
const feePayerKeypair = await loadOrCreateSigner("fee-payer");

/** Placeholder spend cap. 0.01 USDC in atomic units. Postgres-backed later. */
const MAX_ATOMIC_PER_PAYMENT = 10_000n;

// KNOWN LIMIT: module-level, so two concurrent settles can read each other's
// veto. Correct only because this demo is single-flight. The fix is not a Map
// — it is to key the refusal reason by payment in the Postgres ledger, which
// the PendingSettlementStore work introduces.
let policyVeto: string | undefined;

// Wraps a kit signer into the shape x402 needs: getAddresses() + signTransaction().
//   @x402/svm 2.28.0 -> signer-gUqhJy7y.d.mts:50 (FacilitatorSvmSigner)
const signer = toFacilitatorSvmSigner(feePayerKeypair, {
  defaultRpcUrl: RPC_URL,
});

//   @x402/core 2.28.0 -> facilitator/index.d.mts:51
const facilitator = new x402Facilitator();

//   @x402/svm 2.28.0 -> exact/facilitator/index.d.mts:44
//   config is { signer, networks } — it does NOT accept a settlement cache or
//   scheme options; we build the scheme by hand when we need those.
registerExactSvmScheme(facilitator, { signer, networks: SOLANA_DEVNET_CAIP2 });

/**
 * Stipend's spend policy.
 *
 * This hook is the ONLY place in the system that knows a refusal was a policy
 * veto rather than a malformed payment. Both reach the merchant as
 * success:false, so the distinction is carried deliberately in refusalKind —
 * never parsed back out of an error message.
 *   @x402/core 2.28.0 -> facilitator/index.d.mts (FacilitatorBeforeSettleHook)
 */
facilitator.onBeforeSettle(async ({ requirements }) => {
  policyVeto = undefined;
  const amount = BigInt(requirements.amount);
  console.log(`[policy] settle requested: ${amount} of ${requirements.asset}`);

  if (amount > MAX_ATOMIC_PER_PAYMENT) {
    policyVeto = `per-payment cap ${MAX_ATOMIC_PER_PAYMENT} exceeded by ${amount}`;
    console.log(`[policy] VETO: ${policyVeto}`);
    return { abort: true, reason: policyVeto };
  }
  return;
});

const app = express();
app.use(express.json());

app.get("/supported", (_req, res) => {
  const all = facilitator.getSupported();
  // registerExactSvmScheme also registers v1 shims, which fan out to mainnet
  // and testnet names we never asked for. Advertise only what we can settle.
  res.json({
    ...all,
    kinds: all.kinds.filter((k) => k.network === SOLANA_DEVNET_CAIP2),
  });
});

/**
 * Expiry deadline from the 402, shared by /verify and /settle.
 *
 * A missing deadline makes expiry UNPROVABLE, so it returns a sentinel no
 * block height can exceed. Defaulting to 0n would mark every payment expired
 * and invite the agent to pay again with no evidence.
 */
function deadlineOf(paymentRequirements: any): bigint {
  const d = paymentRequirements?.extra?.lastValidBlockHeight;
  return d === undefined ? 2n ** 64n : BigInt(String(d));
}

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};
  try {
    const result = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    // Verify never broadcasts, so there is never a signature here. classify
    // therefore decides on arithmetic alone: past the deadline -> expired and
    // safe to re-sign; inside it -> rejected on the merits.
    //
    // KNOWN LIMIT: "AlreadyProcessed" lands in `rejected`, which is the SAFE
    // answer (do not retry) but not the TRUE one (the money already moved).
    // Telling those apart needs a ledger lookup keyed by request — the
    // verify response carries no signature, and the only other route is
    // string-matching the error, which is exactly what classify avoids.
    const verdict = result.isValid
      ? undefined
      : classify({
          phase: "verify",
          ok: result.isValid,
          signature: "",
          errorText: result.invalidMessage ?? result.invalidReason,
          lastValidBlockHeight: deadlineOf(paymentRequirements),
          currentBlockHeight: await getBlockHeight(),
          refusalKind: result.isValid ? undefined : "terms",
        });

    console.log(
      `[verify] ${result.isValid ? "VALID" : `INVALID ${result.invalidReason ?? ""} ${result.invalidMessage ?? ""} -> ${verdict!.state}`}`,
    );

    res.json(
      verdict
        ? { ...result, extra: { ...result.extra, stipend: verdict } }
        : result,
    );
  } catch (err) {
    console.error("[verify] threw:", err instanceof Error ? err.message : err);
    res.status(400).json({ isValid: false, invalidReason: String(err) });
  }
});

app.post("/settle", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body ?? {};

  // Shared by both outcomes: expiry is decided by arithmetic against the
  // 402's deadline, so both the returned and the thrown path need it.
  const deadline = paymentRequirements?.extra?.lastValidBlockHeight;
  // No deadline means expiry is UNPROVABLE. A sentinel no height can exceed
  // keeps it out of `expired` — the safe side. (0n would make every height
  // "past" it and wrongly invite the agent to re-pay.)
  const lastValidBlockHeight =
    deadline === undefined ? 2n ** 64n : BigInt(String(deadline));

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
      currentBlockHeight: await getBlockHeight(),
      refusalKind: policyVeto ? "policy" : args.signature ? undefined : "terms",
    });
    console.log(
      `[settle] ${verdict.state} resignable=${verdict.resignable} ` +
        `retryableLater=${verdict.retryableLater} — ${verdict.reason}`,
    );
    res.json({
      ...args.base,
      extra: { ...(args.base.extra ?? {}), stipend: verdict },
    });
  };

  try {
    const result = await facilitator.settle(
      paymentPayload,
      paymentRequirements,
    );
    // transaction is a REQUIRED string in @x402/core, so a refusal that never
    // broadcast arrives as "". classify normalises that to "no signature".
    await reply({
      ok: result.success,
      signature: result.transaction,
      errorText: result.errorMessage ?? result.errorReason,
      base: result as unknown as Record<string, unknown>,
    });
  } catch (err) {
    // A policy abort THROWS here (x402Facilitator.ts:418) rather than
    // returning success:false. It is a legitimate outcome, not a crash, and
    // must carry the same structured verdict as every other path —
    // otherwise retryableLater is invisible exactly when it matters.
    //
    // No broadcast happened on this path, so the signature is "".
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
        network: paymentRequirements?.network,
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`facilitator on :${PORT}, fee payer ${feePayerKeypair.address}`);
});
