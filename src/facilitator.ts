import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "./keys";

const PORT = Number(process.env.FACILITATOR_PORT ?? 3000);
const RPC_URL =
  process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";

// The ONLY wallet in Stipend that holds SOL. It never holds USDC and never
// moves the agent's money — it occupies the fee-payer slot and signs for that
// slot alone.
const feePayerKeypair = await loadOrCreateSigner("fee-payer");

// Wraps a kit signer into the shape x402 needs: getAddresses() + signTransaction().
//   @x402/svm 2.28.0 -> signer-gUqhJy7y.d.mts:50 (FacilitatorSvmSigner)
const signer = toFacilitatorSvmSigner(feePayerKeypair, {
  defaultRpcUrl: RPC_URL,
});

//   @x402/core 2.28.0 -> facilitator/index.d.mts:51
const facilitator = new x402Facilitator();

//   @x402/svm 2.28.0 -> exact/facilitator/index.d.mts:44
//   config is { signer, networks } — note it does NOT accept a settlement
//   cache or scheme options; we build the scheme by hand when we need those.
registerExactSvmScheme(facilitator, {
  signer,
  networks: SOLANA_DEVNET_CAIP2,
});

// Placeholder for Stipend's actual contribution. Returning
// { abort: true, reason } here refuses settlement — this is where the
// Postgres-backed spend limit will live.
//   @x402/core 2.28.0 -> facilitator/index.d.mts (FacilitatorBeforeSettleHook)
facilitator.onBeforeSettle(async ({ requirements }) => {
  console.log(
    `[policy] settle requested: ${requirements.amount} of ${requirements.asset}`,
  );
});

const app = express();
app.use(express.json());

app.get("/supported", (_req, res) => {
  const all = facilitator.getSupported();
  // registerExactSvmScheme also registers v1 shims, which fan out to mainnet
  // and testnet names we never asked for. Stipend is devnet-only this week;
  // advertise only what we can actually settle.
  res.json({
    ...all,
    kinds: all.kinds.filter((k) => k.network === SOLANA_DEVNET_CAIP2),
  });
});

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );
    console.log(
      `[verify] ${result.isValid ? "VALID" : "INVALID"} ${result.invalidReason ?? ""} ${result.invalidMessage ?? ""}`,
    );
    res.json(result);
  } catch (err) {
    console.error("[verify] threw:", err);
    res.status(400).json({ isValid: false, invalidReason: String(err) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.settle(
      paymentPayload,
      paymentRequirements,
    );
    console.log(
      `[settle] success=${result.success} ${result.errorReason ?? ""} tx=${result.transaction}`,
    );
    res.json(result);
  } catch (err) {
    console.error("[settle] threw:", err);
    res.status(400).json({ success: false, errorReason: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`facilitator on :${PORT}, fee payer ${feePayerKeypair.address}`);
});
