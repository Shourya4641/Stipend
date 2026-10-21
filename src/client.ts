import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { getBlockHeight } from "../shared/chain";
import { classify } from "../shared/classify";
import { CONSTANTS } from "../shared/constants";

const URL = `${CONSTANTS.MERCHANT_URL}/safety-check?mint=So11111111111111111111111111111111111111112`;

// Holds USDC and zero SOL. It cannot broadcast anything by itself — that is
// the constraint the whole design exists to work around.
const agent = await loadOrCreateSigner("agent");

const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) });

/**
 * Remember the deadline of the challenge we actually signed against.
 *
 * Needed because a failed payment gets a FRESH 402 back, with a new
 * blockhash and a new lastValidBlockHeight. Diagnosing expiry from the
 * response would compare against a deadline we never used, and nothing
 * would ever look expired.
 *
 * registerPolicy is a selection filter; here it is a pass-through that
 * records as a side effect.
 *   @x402/core 2.28.0 -> x402Client-C7_OogbK.d.mts:2029 / PaymentPolicy :1881
 */
let observedDeadline: bigint | undefined;
client.registerPolicy((_version, requirements) => {
  const d = requirements[0]?.extra?.["lastValidBlockHeight"];
  observedDeadline = d === undefined ? undefined : BigInt(String(d));
  return requirements;
});

// STALL_MS stalls the agent between receiving the 402 and signing against
// it, so the blockhash dies in the gap. This is the real failure — a slow
// agent, a slow network — not a fabricated input.
const STALL_MS = Number(process.env.STALL_MS ?? 0);
if (STALL_MS > 0) {
  let stalled = false;
  client.registerPolicy((_v, requirements) => {
    // ONE-SHOT: the retry must get a fair run, or it expires identically
    // and we learn nothing about recovery.
    if (stalled) return requirements;
    stalled = true;
    const until = Date.now() + STALL_MS;
    console.log(`[stall] holding ${STALL_MS}ms before signing...`);
    while (Date.now() < until) { /* block; policies are sync */ }
    return requirements;
  });
}

const pay = wrapFetchWithPayment(fetch, client);

function decode(res: Response, name: string): unknown {
  const v = res.headers.get(name);
  if (!v) return null;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return v;
  }
}

async function attempt(label: string) {
  // The deadline belongs to THIS attempt, so it is cleared before and
  // snapshotted immediately after. Leaving it in a module-level variable
  // would break two ways: concurrent requests clobber each other between
  // signing and diagnosis, and a stale value survives an attempt whose
  // selection or signing failed, so the next diagnosis compares against a
  // deadline from a payment that was never made.
  observedDeadline = undefined;
  const res = await pay(URL);
  const deadline = observedDeadline;

  const settlement = decode(res, "payment-response");
  console.log(`\n[${label}] status ${res.status}`);
  if (settlement) console.log(JSON.stringify(settlement, null, 2));
  return { res, settlement, deadline };
}

console.log(`agent ${agent.address} requesting ${URL}`);

let { res, settlement, deadline } = await attempt("attempt 1");

// A 402 with no settlement header means the payment died at VERIFY, and the
// merchant drops VerifyResponse.extra — so no verdict reaches us.
//
// We don't need one. The 402 gave us the deadline and the chain will give us
// the height. This runs the SAME classify the facilitator runs, on the same
// inputs, in a different process: one module, two callers, so they cannot
// drift apart. And we trust nobody's report of whether our own payment died.
if (res.status === 402 && !settlement && deadline !== undefined) {
  const verdict = classify({
    phase: "verify",
    ok: false,
    signature: "",
    lastValidBlockHeight: deadline,
    currentBlockHeight: await getBlockHeight(),
  });
  console.log(`\n[diagnosis] ${verdict.state} resignable=${verdict.resignable} — ${verdict.reason}`);

  if (verdict.resignable) {
    // Safe ONLY because nothing was broadcast: past lastValidBlockHeight a
    // Solana transaction is permanently dead, so the original cannot land
    // late and this is one payment, not two.
    console.log("[diagnosis] expired before broadcast — paying once more");
    ({ res, settlement, deadline } = await attempt("attempt 2"));
  } else {
    // LIMIT: AlreadyProcessed lands here too. Not retrying is the safe
    // answer, but we cannot tell "already paid" from "malformed" without a
    // ledger keyed by request.
    console.log("[diagnosis] not resignable — stopping");
  }
}

console.log(`\nfinal status ${res.status}`);
console.log(await res.text());
