/**
 * Entrypoint. The only file here that reads the environment, constructs real
 * dependencies, or opens a port (D5).
 */
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { loadConfig } from "./config";
import { createApp } from "./app";

const config = loadConfig();

// The merchant holds no SOL and no key it can spend with — only its own
// address, to be paid into.
const merchant = await loadOrCreateSigner("merchant");

//   @x402/core 2.28.0 -> HTTPFacilitatorClient, constructor(config?: FacilitatorConfig)
const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

//   @x402/core 2.28.0 -> x402ResourceServer(facilitatorClients?)
const server = new x402ResourceServer(facilitatorClient);

//   @x402/svm 2.28.0 -> exact/server/index.d.mts:117
//   rpcUrl set so the 402 carries extra.recentBlockhash (see :103-108)
registerExactSvmScheme(server, {
  networks: [SOLANA_DEVNET_CAIP2],
  rpcUrl: config.chain.rpcUrl,
});

createApp({
  server,
  payTo: merchant.address,
  price: config.price,
  maxTimeoutSeconds: config.maxTimeoutSeconds,
  syncFacilitatorOnStart: true,
}).listen(config.port, () => {
  console.log(`merchant on :${config.port}, paid to ${merchant.address}`);
});
