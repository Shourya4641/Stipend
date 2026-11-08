/**
 * Entrypoint. The only file here that touches the environment, constructs
 * real dependencies, or opens a port (D5).
 */
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { toFacilitatorSvmSigner, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { loadFeePayer } from "./signer";
import { createChain } from "../shared/chain";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { createLedger } from "./db/ledger";
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

// Applied at startup on a separate single connection. A facilitator whose
// schema is behind must not serve: it would write rows the code cannot read.
await runMigrations(config.databaseUrl);
const { db, close: closeDb } = createDb(config.databaseUrl);
const ledger = createLedger(db);

// Let in-flight queries finish rather than dropping them mid-settle.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await closeDb();
    process.exit(0);
  });
}

// The ONLY wallet in Stipend that holds SOL. It never holds USDC and never
// moves the agent's money — it occupies the fee-payer slot and signs for
// that slot alone.
const feePayerKeypair = await loadFeePayer();

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

createApp({
  facilitator,
  chain,
  ledger,
  logger,
  policy: config.policy,
  feePayer: feePayerKeypair.address,
}).listen(config.port, "::", () => {
  // The active caps are logged at startup so a wrong one is visible
  // immediately, not after four payments have gone through.
  logger.info(
    {
      port: config.port,
      feePayer: feePayerKeypair.address,
      maxPerPayment: config.policy.maxAtomicPerPayment,
      windowCap: config.policy.windowCapAtomic,
      windowMinutes: config.policy.windowMs / 60_000,
    },
    "facilitator listening",
  );
});
