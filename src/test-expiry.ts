import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "./keys";
import { getBlockHeight, solLamports } from "./chain";

const RPC_URL = process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";
const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://127.0.0.1:4021";
const URL = `${MERCHANT_URL}/safety-check?mint=So11111111111111111111111111111111111111112`;

const agent = await loadOrCreateSigner("agent");
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(agent) });

const httpClient = new x402HTTPClient(client);

// CONTROL: a fresh payment, submitted immediately, MUST be accepted.
// If this fails the encoding is wrong and the expiry result means nothing.
{
  const c = await fetch(URL);
  const h = c.headers.get("payment-required");
  if (!h) throw new Error("no PAYMENT-REQUIRED header");
  const req = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  const p = await client.createPaymentPayload(req);
  const r = await fetch(URL, { headers: httpClient.encodePaymentSignatureHeader(p) });
  console.log(`CONTROL (fresh payment): status ${r.status} — ${r.status === 200 ? "ok" : "ENCODING BROKEN, expiry result is meaningless"}`);
  if (r.status !== 200) process.exit(1);
}

const before = await solLamports(agent.address);
console.log(`agent SOL before: ${before}`);

// 1. Get the challenge.
const challenge = await fetch(URL);
const header = challenge.headers.get("payment-required");
if (!header) throw new Error("no PAYMENT-REQUIRED header");
const required = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
const deadline = BigInt(required.accepts[0].extra.lastValidBlockHeight);
console.log(`challenge deadline: block ${deadline}`);

// 2. Sign NOW, against a blockhash that is already ticking.
const payload = await client.createPaymentPayload(required);
console.log("payment signed, holding it...");

// 3. Wait until the chain is past the deadline.
while (true) {
  const height = await getBlockHeight();
  if (height > deadline) {
    console.log(`chain at ${height} > ${deadline} — payment is now dead`);
    break;
  }
  process.stdout.write(`\r  block ${height} / ${deadline}  `);
  await new Promise((r) => setTimeout(r, 3000));
}

// 4. Submit the stale payment.
// Real encoder, not a hand-rolled base64 guess.
// @x402/fetch 2.28.0 index.mjs wraps a bare client this same way.
const res = await fetch(URL, { headers: httpClient.encodePaymentSignatureHeader(payload) });
console.log(`\nmerchant status: ${res.status}`);
console.log(`body: ${(await res.text()).slice(0, 200)}`);

const after = await solLamports(agent.address);
console.log(`agent SOL after:  ${after}  (delta ${after - before})`);
console.log(
  res.status === 200
    ? "FAIL — resource released on an expired payment"
    : "PASS — resource withheld",
);
