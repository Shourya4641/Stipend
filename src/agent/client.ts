import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { createChain } from "../shared/chain";
import { classify } from "../shared/classify";
import { loadConfig } from "./config";

// Parsed once, here at the entrypoint — never at import time (D3).
const config = loadConfig();
const chain = createChain(config.chain);

//! Suggestion - make the address So111.. as a constant and then call it here rather than hard coding it.
const URL = `${config.merchantUrl}/safety-check?mint=So11111111111111111111111111111111111111112`;

// Holds USDC and zero SOL. It cannot broadcast anything by itself
const agent = await loadOrCreateSigner("agent"); //! Understanding question - When this goes live, how is this signer creation supposed to work?

const client = new x402Client();
//! Understanding question - using registerExactSvmScheme() so we are saying look our x402 client is eligiable to make some payments via SVM i.e. Solana? correct me if I am wrong
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) }); //! General question -  why do we need this toClientSvmSigner() at all? Like otherwise what would happen if we don't use it?

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
//! Understanding question - when the registerPolicy() runs for the first time, what values are we passing for _version and requirements?
//! Understanding question - how are we relating the dealine with the challenge that we signed against?
let observedDeadline: bigint | undefined;
client.registerPolicy((_version, requirements) => {
  const deadline = requirements[0]?.extra?.["lastValidBlockHeight"];
  observedDeadline = deadline === undefined ? undefined : BigInt(String(deadline));
  return requirements;
});

// STALL_MS stalls the agent between receiving the 402 and signing against
// it, so the blockhash dies in the gap. This is the real failure — a slow
// agent, a slow network — not a fabricated input.
//! Understanding question - Do we need this in production or when we go live?
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

//! Understanding question - Any reason to keep the return type as unknown .. this is considered as settlement value later?
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
  const deadline = observedDeadline; //!Understanding question - where this deadline is being used actually?

  const settlement = decode(res, "payment-response");
  console.log(`\n[${label}] status ${res.status}`);
  if (settlement) console.log(JSON.stringify(settlement, null, 2));
  return { res, settlement, deadline };
}

console.log(`agent ${agent.address} requesting ${URL}`);

//! Understanding question - We are hardcoding the attempt number like attempt 1 .. why so?
//! Understanding question - Is there is a cap on the number of attempts? If yes then how many, and how are we deciding that cap? If no then why do we not have it?
let { res, settlement, deadline } = await attempt("attempt 1");

//! Understanding question - I didn't understand this died at VERIFY thing .. Want clarification on what is happening and when can we expect a payment to fail?
// A 402 with no settlement header means the payment died at VERIFY, and the
// merchant drops VerifyResponse.extra — so no verdict reaches us.
//
// We don't need one. The 402 gave us the deadline and the chain will give us
// the height. This runs the SAME classify the facilitator runs, on the same
// inputs, in a different process: one module, two callers, so they cannot
// drift apart. And we trust nobody's report of whether our own payment died.
if (res.status === 402 && !settlement && deadline !== undefined) {
  //! Suggestion - here first build the ClassifyInput structure using the values and then pass to the function.
  //! Understanding question - what are the different phases that we are considering across this project? And what is the inference that we are making based on the phase? 
  const verdict = classify({
    phase: "verify", //! Suggestion - use of enums across the across the project is suggested but then if we can't then I want a proper reasoning for that too. I won't point the same use enum suggestion at all places so this comment is meant to be considered for the entire service.
    ok: false,
    signature: "",
    lastValidBlockHeight: deadline,
    currentBlockHeight: await chain.getBlockHeight(), //! Understanding question - this is an on chain call .. what if the rpc is down or something like that?
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
    //! Understanding question - Is there a better way to handle this? 
    console.log("[diagnosis] not resignable — stopping");
  }
}

console.log(`\nfinal status ${res.status}`);
console.log(await res.text());
