import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { loadOrCreateSigner } from "./keys";

const RPC_URL =
  process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";
const MERCHANT_URL = process.env.MERCHANT_URL ?? "http://127.0.0.1:4021";

// Holds USDC and zero SOL. It cannot broadcast anything by itself — that is
// the constraint the whole design exists to work around.
const agent = await loadOrCreateSigner("agent");

//   @x402/svm 2.28.0 -> signer-gUqhJy7y.d.mts (toClientSvmSigner, export `t`)
const signer = toClientSvmSigner(agent);

const client = new x402Client();

//   @x402/svm 2.28.0 -> exact/client/index.d.mts:37
//   registerExactSvmScheme(client, config: SvmClientConfig): x402Client
registerExactSvmScheme(client, { signer });

//   @x402/fetch 2.28.0 -> index.d.mts:42
const pay = wrapFetchWithPayment(fetch, client);

const url = `${MERCHANT_URL}/safety-check?mint=So11111111111111111111111111111111111111112`;
console.log(`agent ${agent.address} requesting ${url}`);

const res = await pay(url);
console.log(`status ${res.status}`);
console.log(await res.text());
