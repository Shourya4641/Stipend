import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadAgentSigner } from "./signer";
import { createChain } from "../shared/chain";
import { classify } from "../shared/classify";
import { Phase, SettlementState } from "../shared/enums";
import { loadConfig } from "./config";

// Parsed once, here at the entrypoint — never at import time (D3).
const config = loadConfig();
const chain = createChain(config.chain);

/** wSOL, used only as a sample mint for the demo request. */
/** wSOL by default; override with MINT= to check a different token. */
const SAMPLE_MINT =
  process.env["MINT"] ?? "So11111111111111111111111111111111111111112";
const URL = `${config.merchantUrl}/safety-check?mint=${SAMPLE_MINT}`;

// Holds USDC and zero SOL — it cannot broadcast anything by itself.
//
// LIVE DEPLOYMENT (D13): loadOrCreateSigner is demo scaffolding and lives in
// tools/ for that reason. An operator funds their own wallet and sets their
// own limit; the library must ACCEPT a signer, never create one. A missing
// key in production is a hard failure, not a silently generated new wallet.
const agent = await loadAgentSigner();

const client = new x402Client();

// Registers scheme AND network: the `exact` scheme for solana:…. Offered
// anything else, the client has no scheme and declines.
// toClientSvmSigner adapts a @solana/kit signer to the interface @x402/svm
// expects — an adapter at a library boundary. Note it takes no RPC, unlike
// the facilitator's: the agent only signs its own slot and hands the bytes
// away. That asymmetry is what lets a wallet with zero SOL participate.
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) });

/**
 * Record the deadline of the challenge we actually signed against.
 *
 * A failed payment gets a FRESH 402 with a new blockhash, so diagnosing
 * expiry from the response would compare against a deadline we never used
 * and nothing would ever look expired. The hook fires during selection —
 * after the 402 arrives, before signing — so this is the right moment.
 *
 * A pass-through filter used as an observation point.
 *   @x402/core 2.28.0 -> x402Client-C7_OogbK.d.mts:2029 / PaymentPolicy :1881
 */
let observedDeadline: bigint | undefined;
client.registerPolicy((_version, requirements) => {
  const deadline = requirements[0]?.extra?.["lastValidBlockHeight"];
  observedDeadline = deadline === undefined ? undefined : BigInt(String(deadline));
  return requirements;
});

const pay = wrapFetchWithPayment(fetch, client);

function decodeHeader(res: Response, name: string): unknown {
  const v = res.headers.get(name);
  if (!v) return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return v;
  }
}

async function attempt(n: number) {
  // The deadline belongs to THIS attempt: cleared before, snapshotted
  // immediately after. A module-level value breaks two ways — concurrent
  // requests clobber each other between signing and diagnosis, and a stale
  // value survives an attempt whose signing failed, so the next diagnosis
  // compares against a payment that was never made.
  observedDeadline = undefined;
  const res = await pay(URL);
  const deadline = observedDeadline;

  const settlement = decodeHeader(res, "payment-response");
  console.log(`\n[attempt ${n}] status ${res.status}`);
  if (settlement) console.log(JSON.stringify(settlement, null, 2));
  return { res, settlement, deadline };
}

console.log(`agent ${agent.address} requesting ${URL}`);

let n = 1;
let { res, settlement, deadline } = await attempt(n);

/**
 * A 402 with no PAYMENT-RESPONSE means the payment died at VERIFY: the
 * merchant asked the facilitator, the answer was no, and nothing was
 * broadcast. The merchant drops VerifyResponse.extra, so no verdict reaches
 * us — but we don't need one. The 402 gave us the deadline and the chain
 * gives us the height.
 *
 * This runs the SAME classify the facilitator runs, on the same inputs, in a
 * different process: one module, two callers, so they cannot drift. And we
 * trust nobody's report of whether our own payment died.
 */
while (res.status === 402 && !settlement && deadline !== undefined && n <= config.maxRetries) {
  let currentBlockHeight: bigint;
  try {
    currentBlockHeight = await chain.getBlockHeight();
  } catch (err) {
    // UNKNOWN IS NEVER RESIGNABLE. Without a height we cannot prove the
    // payment expired, and the previous code crashed here — after an
    // attempt whose outcome we do not know, which is the worst possible
    // moment to die.
    console.error(`[diagnosis] cannot reach the chain, so not retrying: ${String(err)}`);
    break;
  }

  const verdict = classify({
    phase: Phase.Verify,
    ok: false,
    signature: "",
    lastValidBlockHeight: deadline,
    currentBlockHeight,
  });
  console.log(`\n[diagnosis] ${verdict.state} resignable=${verdict.resignable} — ${verdict.reason}`);

  if (!verdict.resignable) {
    // LIMIT (D10): AlreadyProcessed lands here too. Not retrying is the SAFE
    // answer but not the TRUE one — the money already moved and the honest
    // reply is a receipt. Telling those apart needs a ledger keyed by
    // payment-identifier.
    console.log(`[diagnosis] ${verdict.state} is not resignable — stopping`);
    break;
  }

  // Safe ONLY because nothing was broadcast: past lastValidBlockHeight a
  // Solana transaction is permanently dead, so the original cannot land late
  // and this is one payment, not two.
  if (verdict.state !== SettlementState.Expired) break;

  n += 1;
  console.log(`[diagnosis] expired before broadcast — paying again (${n}/${config.maxRetries + 1})`);
  ({ res, settlement, deadline } = await attempt(n));
}

console.log(`\nfinal status ${res.status} after ${n} attempt(s)`);
console.log(await res.text());
