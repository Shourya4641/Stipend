import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "../tools/keys";
import { createChain } from "../shared/chain";
import { loadConfig } from "../tools/config";

const chain = createChain(loadConfig().chain);

const RPC_URL = process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";
const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://127.0.0.1:4021";
const URL = `${MERCHANT_URL}/safety-check?mint=So11111111111111111111111111111111111111112`;

const agent = await loadOrCreateSigner("agent");
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) });
const httpClient = new x402HTTPClient(client);


function verdictOf(res: Response): unknown {
  const h = res.headers.get("payment-response");
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return h;
  }
}

const before = (await chain.usdcBalance(agent.address)).atomic;
console.log(`agent USDC before: ${before}`);

// --- One challenge, one signed payment. ---------------------------------
const challenge = await fetch(URL);
const header = challenge.headers.get("payment-required");
if (!header) throw new Error("no PAYMENT-REQUIRED header");
const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const price = BigInt(required.accepts[0].amount);
console.log(`price: ${price} atomic`);

const payload = await client.createPaymentPayload(required);
const headers = httpClient.encodePaymentSignatureHeader(payload);

// --- Submit it. ----------------------------------------------------------
const first = await fetch(URL, { headers });
console.log(`\nFIRST  status ${first.status}`);
console.log(JSON.stringify(verdictOf(first), null, 2));

// --- Submit the EXACT same bytes again. ----------------------------------
// Same signed transaction, same memo nonce, same signature. This is a client
// that retried because it thought the first response was lost.
const second = await fetch(URL, { headers });
console.log(`\nSECOND status ${second.status}`);
console.log(JSON.stringify(verdictOf(second), null, 2));

// --- What did it cost? ---------------------------------------------------
// Settlement is confirmed before the merchant replies, so no sleep needed;
// if the number looks mid-flight, re-run src/balances.ts to confirm.
const after = (await chain.usdcBalance(agent.address)).atomic;
const spent = before - after;
console.log(`\nagent USDC after:  ${after}`);
console.log(`spent: ${spent} atomic (one payment = ${price})`);

const served = [first.status, second.status].filter((s) => s === 200).length;

console.log(`\nresource served ${served} time(s), paid ${spent} atomic`);
if (spent > price) console.log("FAIL — agent paid more than once for one request");
else if (served > 1 && spent === price) console.log("FAIL — merchant served twice for one payment");
else if (served === 1 && spent === price) console.log("PASS — one payment, one response");
else console.log(`UNEXPECTED — served=${served} spent=${spent}`);
