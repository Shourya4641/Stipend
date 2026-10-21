import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { classify, classifyPass } from "../shared/classify";
import { getBlockHeight } from "../shared/chain";
import { parseFacilitatorRequest, deadlineOf, WireError, attemptId } from "./wire";
import { decide } from "./policy";
import { CONSTANTS } from "../shared/constants";

// The ONLY wallet in Stipend that holds SOL. It never holds USDC and never
// moves the agent's money — it occupies the fee-payer slot and signs for
// that slot alone.
const feePayerKeypair = await loadOrCreateSigner("fee-payer");

// KNOWN LIMIT: module-level, so two concurrent settles can read each
// other's veto. Correct only because this demo is single-flight. The fix is
// not a Map — it is to key the refusal reason by payment in the Postgres
// ledger, which the PendingSettlementStore work introduces.
let policyVeto: string | undefined;

// Wraps a kit signer into the shape x402 needs: getAddresses() + signTransaction().
//   @x402/svm 2.28.0 -> signer-gUqhJy7y.d.mts:50 (FacilitatorSvmSigner)
const signer = toFacilitatorSvmSigner(feePayerKeypair, {
  defaultRpcUrl: CONSTANTS.RPC_URL,
});

//   @x402/core 2.28.0 -> facilitator/index.d.mts:51
const facilitator = new x402Facilitator();

//   @x402/svm 2.28.0 -> exact/facilitator/index.d.mts:44
//   config is { signer, networks } — it does NOT accept a settlement cache
//   or scheme options; we build the scheme by hand when we need those.
registerExactSvmScheme(facilitator, { signer, networks: SOLANA_DEVNET_CAIP2 });

//   @x402/core 2.28.0 -> facilitator/index.d.mts (FacilitatorBeforeSettleHook)
facilitator.onBeforeSettle(async ({ requirements }) => {
  policyVeto = undefined;
  const amount = BigInt(requirements.amount);
  const decision = decide(amount);

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
 * A body we could not read is NOT a payment outcome.
 *
 * It gets a 400 and no verdict. Classifying it would put a protocol error
 * into the settlement channel, telling the payer their terms were refused
 * when in fact we never understood the request.
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
    // Telling those apart needs a ledger keyed by request.
    const verdict = result.isValid
      ? classifyPass("verify")
      : classify({
          phase: "verify",
          ok: false,
          signature: "",
          errorText: result.invalidMessage ?? result.invalidReason,
          lastValidBlockHeight: deadlineOf(paymentRequirements),
          currentBlockHeight: await getBlockHeight(),
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
      currentBlockHeight: await getBlockHeight(),
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
        network: paymentRequirements["network"],
      },
    });
  }
});

app.listen(CONSTANTS.FACILITATOR_PORT, () => {
  console.log(
    `facilitator on :${CONSTANTS.FACILITATOR_PORT}, fee payer ${feePayerKeypair.address}`,
  );
});
