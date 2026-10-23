/**
 * The clip worth filming: a stalled agent diagnoses its own expiry and
 * recovers, paying exactly once across two attempts.
 *
 * A HARNESS, not product code. The stall is a busy-wait inside a policy
 * hook because PaymentPolicy is synchronous and cannot await — indefensible
 * in a service, fine in a script whose whole job is to make a real failure
 * happen on demand.
 *
 *   pnpm exec tsx src/harness/agent-recovery-devnet.ts
 *   STALL_MS=75000 pnpm exec tsx src/harness/agent-recovery-devnet.ts
 *
 * Needs the facilitator and merchant running, and a funded agent.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "../tools/keys";
import { createChain } from "../shared/chain";
import { classify } from "../shared/classify";
import { Phase } from "../shared/enums";
import { loadConfig } from "../tools/config";

const config = loadConfig();
const chain = createChain(config.chain);
const URL = `${config.merchantUrl}/safety-check?mint=So11111111111111111111111111111111111111112`;
const STALL_MS = Number(process.env["STALL_MS"] ?? 75_000);

const agent = await loadOrCreateSigner("agent");
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) });

let observedDeadline: bigint | undefined;
client.registerPolicy((_v, requirements) => {
  const d = requirements[0]?.extra?.["lastValidBlockHeight"];
  observedDeadline = d === undefined ? undefined : BigInt(String(d));
  return requirements;
});

// The stall must sit between THE AGENT'S challenge and THE AGENT'S signing.
// Warming the merchant's cache does nothing: it fetches a fresh blockhash
// per request, so the agent's own 402 arrives current however long we wait.
//
// wrapFetchWithPayment does challenge-then-sign in one call with no seam,
// so this drives the two halves directly.
async function sleep(ms: number): Promise<void> {
  // setTimeout, never a busy-wait: blocking the event loop starves the open
  // connection and the payment fails with "fetch failed" before anything
  // expires — a different failure wearing the same clothes.
  await new Promise((r) => setTimeout(r, ms));
}

const pay = wrapFetchWithPayment(fetch, client);
const usdc = async () => (await chain.usdcBalance(agent.address)).atomic;

const before = await usdc();
console.log(`agent USDC before: ${before}`);

// ── Phase 1: get a challenge, sit on it until it dies, then submit it.
const challenge = await fetch(URL);
const header = challenge.headers.get("payment-required");
if (!header) throw new Error("no PAYMENT-REQUIRED header");
const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const deadline = BigInt(String(required.accepts[0].extra.lastValidBlockHeight));
console.log(`challenge deadline: block ${deadline}`);

const payload = await client.createPaymentPayload(required);
console.log(`[stall] signed; holding ${STALL_MS}ms so the blockhash dies`);
await sleep(STALL_MS);

const httpClient = new x402HTTPClient(client);
const first = await fetch(URL, { headers: httpClient.encodePaymentSignatureHeader(payload) });
console.log(`\n[attempt 1] status ${first.status}`);

if (first.status === 200) {
  console.log("FAIL — the stalled payment was ACCEPTED, so nothing expired");
  process.exit(1);
}

// ── Diagnosis: the agent works out for itself that it expired.
const verdict = classify({
  phase: Phase.Verify,
  ok: false,
  signature: "",
  lastValidBlockHeight: deadline,
  currentBlockHeight: await chain.getBlockHeight(),
});
console.log(`[diagnosis] ${verdict.state} resignable=${verdict.resignable} — ${verdict.reason}`);

if (verdict.state !== "expired" || !verdict.resignable) {
  console.log("FAIL — expected an expired, resignable verdict");
  process.exit(1);
}

// ── Phase 2: recover. A fresh challenge, a fresh transaction, one payment.
console.log("[diagnosis] expired before broadcast — paying once more");
const second = await pay(URL);
console.log(`\n[attempt 2] status ${second.status}`);

const after = await usdc();
const spent = before - after;
console.log(`\nagent USDC after:  ${after}`);
console.log(`spent ${spent} atomic across TWO attempts`);

// Asserts the whole story, not just the money: a plain successful payment
// also spends 1000, which is why the previous version passed on a run that
// demonstrated nothing.
const ok = first.status === 402 && second.status === 200 && spent === 1000n;
console.log(ok ? "PASS — stalled, expired, diagnosed, recovered, paid once" : "FAIL");
process.exit(ok ? 0 : 1);
