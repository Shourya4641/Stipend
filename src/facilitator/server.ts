/**
 * Entrypoint. The only file here that touches the environment, constructs
 * real dependencies, or opens a port (D5).
 */
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadOrCreateSigner } from "../shared/keys";
import { createChain } from "../shared/chain";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { createLogger } from "../shared/logger";
import { exitOnFatal } from "../shared/http";

exitOnFatal();

const config = loadConfig();
const logger = createLogger({
  service: "facilitator",
  // Pretty in dev, JSON in production. The entrypoint opts in; the app
  // defaults to silent so tests are quiet.
  pretty: process.env["NODE_ENV"] !== "production",
});
const chain = createChain(config.chain);

// The ONLY wallet in Stipend that holds SOL. It never holds USDC and never
// moves the agent's money — it occupies the fee-payer slot and signs for
// that slot alone.
const feePayerKeypair = await loadOrCreateSigner("fee-payer");

// Asymmetric with the agent on purpose (D12): the agent's signer takes no
// RPC because it only signs its own slot and hands the bytes away. The
// facilitator fills the fee-payer slot AND must send and observe, so it
// needs an RPC. The asymmetry encodes the trust boundary.
//   @x402/svm 2.28.0 -> signer-gUqhJy7y.d.mts:50 (FacilitatorSvmSigner)
const signer = toFacilitatorSvmSigner(feePayerKeypair, {
  defaultRpcUrl: config.chain.rpcUrl,
});

//   @x402/core 2.28.0 -> facilitator/index.d.mts:51
const facilitator = new x402Facilitator();

//   @x402/svm 2.28.0 -> exact/facilitator/index.d.mts:44
//   config is { signer, networks } — it does NOT accept a settlement cache
//   or scheme options; we build the scheme by hand when we need those.
registerExactSvmScheme(facilitator, { signer, networks: SOLANA_DEVNET_CAIP2 });

createApp({ facilitator, chain, logger }).listen(config.port, () => {
  logger.info({ port: config.port, feePayer: feePayerKeypair.address }, "facilitator listening");
});
