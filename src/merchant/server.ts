/**
 * Entrypoint. The only file here that reads the environment, constructs real
 * dependencies, or opens a port (D5).
 */
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";

import { loadConfig } from "./config";
import { createApp } from "./app";
import { createChain } from "../shared/chain";
import { createSafetyCheck } from "./safety/check";
import { createCache } from "./safety/cache";
import { createLogger } from "../shared/logger";
import { exitOnFatal } from "../shared/http";

exitOnFatal();

const config = loadConfig();
const chain = createChain(config.chain);
const logger = createLogger({
  service: "merchant",
  pretty: process.env["NODE_ENV"] !== "production",
});

// The merchant holds no SOL and no key it can spend with — only its own
// address, to be paid into.
// An address, not a key. The merchant cannot spend and must not be able to.
const payTo = config.payTo;

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
  payTo,
  price: config.price,
  maxTimeoutSeconds: config.maxTimeoutSeconds,
  syncFacilitatorOnStart: true,
  logger,
  safetyCheck: createSafetyCheck(chain.rpc as never),
  cache: createCache(),
  network: SOLANA_DEVNET_CAIP2,
}).listen(config.port, () => {
  logger.info({ port: config.port, payTo }, "merchant listening");
});
