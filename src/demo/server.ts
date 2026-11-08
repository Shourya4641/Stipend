import { loadAgentSigner } from "../agent/signer";
import { createPayer } from "../agent/pay";
import { createChain } from "../shared/chain";
import { createLogger } from "../shared/logger";
import { exitOnFatal } from "../shared/http";
import { loadConfig } from "./config";
import { createApp } from "./app";

exitOnFatal();

const config = loadConfig();
const logger = createLogger({
  service: "demo",
  pretty: process.env["NODE_ENV"] !== "production",
});

const chain = createChain(config.chain);
const signer = await loadAgentSigner();
const pay = createPayer({ signer, chain, maxRetries: config.maxRetries });

createApp({
  pay,
  merchantUrl: config.merchantUrl,
  facilitatorPublicUrl: config.facilitatorPublicUrl,
  payer: signer.address,
  logger,
}).listen(config.port, "::", () => {
  logger.info({ port: config.port, payer: signer.address }, "demo listening");
});
