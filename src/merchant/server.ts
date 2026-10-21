import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";

const PORT = Number(process.env.MERCHANT_PORT ?? 4021);
const RPC_URL =
  process.env.SOLANA_RPC_DEVNET ?? "https://api.devnet.solana.com";
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://127.0.0.1:3000";

// The merchant holds no SOL and no key material it needs to spend with.
// It only needs its own address, to be paid into.
const merchant = await loadOrCreateSigner("merchant");

//   @x402/core 2.28.0 -> x402Client-C7_OogbK.d.mts (HTTPFacilitatorClient)
//   constructor(config?: FacilitatorConfig)
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

//   @x402/core 2.28.0 -> x402ResourceServer
//   constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[])
const server = new x402ResourceServer(facilitatorClient);

//   @x402/svm 2.28.0 -> exact/server/index.d.mts:117
//   rpcUrl set so the 402 carries extra.recentBlockhash (see :103-108)
registerExactSvmScheme(server, {
  networks: [SOLANA_DEVNET_CAIP2],
  rpcUrl: RPC_URL,
});

const app = express();

app.use((req, _res, next) => {
  const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
  console.log(
    `[merchant] ${req.method} ${req.url} payment=${sig ? "YES" : "no"}`,
  );
  next();
});

//   @x402/express 2.28.0 -> index.d.mts:147
//   paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart?)
//   Last arg true: fetch /supported at boot, so a dead facilitator fails
//   loudly now instead of on the first customer.
app.use(
  paymentMiddleware(
    {
      "GET /safety-check": {
        description: "On-chain safety facts for a Solana token mint",
        mimeType: "application/json",
        accepts: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          payTo: merchant.address,
          // No asset field: "$0.001" resolves to the network's default
          // stablecoin, which on devnet is the USDC mint from Stage 1.
          price: "$0.001",
          maxTimeoutSeconds: 60,
        },
      },
    },
    server,
    undefined,
    undefined,
    true,
  ),
);

// Only reached once payment verified. Stub for now — the real on-chain
// checks land after the payment path works end to end.
app.get("/safety-check", (req, res) => {
  res.json({
    mint: req.query.mint ?? null,
    checked: false,
    note: "stub — real checks come after Stage 2",
  });
});

app.listen(PORT, () => {
  console.log(`merchant on :${PORT}, paid to ${merchant.address}`);
});
