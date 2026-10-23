import express from "express";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { loadConfig } from "./config";

const config = loadConfig();

// The merchant holds no SOL and no key material it needs to spend with.
// It only needs its own address, to be paid into.
const merchant = await loadOrCreateSigner("merchant");

//   @x402/core 2.28.0 -> x402Client-C7_OogbK.d.mts (HTTPFacilitatorClient)
//   constructor(config?: FacilitatorConfig)
const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

//   @x402/core 2.28.0 -> x402ResourceServer
//   constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[])
const server = new x402ResourceServer(facilitatorClient);

//   @x402/svm 2.28.0 -> exact/server/index.d.mts:117
//   rpcUrl set so the 402 carries extra.recentBlockhash (see :103-108)
registerExactSvmScheme(server, {
  networks: [SOLANA_DEVNET_CAIP2],
  rpcUrl: config.chain.rpcUrl,
});

//! Suggestion - the building of express app here is too cluttered .. I have written a similar suggestion in the facilitator server too .. please refer that 
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
//! Understanding question - Is there a better way to handle or write this payment middleware because right now there are a lot of static values here? It is good for verifying the happy path but then not sure if we should be going ahead with this design in the final version too .. would like to know more about it and also discuss about it .. and if you think this implementation is correct to go for the final version too then please explain to me why and how too. 
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

//! Understanding question - I am sure this is not the final version of this api? Please explain to me the final version of it and also when we would be building that.
// Only reached once payment verified. Stub for now — the real on-chain
// checks land after the payment path works end to end.
app.get("/safety-check", (req, res) => {
  res.json({
    mint: req.query.mint ?? null,
    checked: false,
    note: "stub — real checks come after Stage 2",
  });
});

app.listen(config.port, () => {
  console.log(`merchant on :${config.port}, paid to ${merchant.address}`);
});
