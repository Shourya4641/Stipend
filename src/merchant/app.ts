import express from "express";
import { paymentMiddleware } from "@x402/express";
import type { x402ResourceServer } from "@x402/core/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { errorHandler } from "../shared/http";
import { silentLogger, type Logger } from "../shared/logger";

export type MerchantDeps = {
  server: x402ResourceServer;
  /** Where payment lands. The merchant holds no key it can spend with. */
  payTo: string;
  price: string;
  maxTimeoutSeconds: number;
  /**
   * Fetch /supported at boot so a dead facilitator fails loudly now rather
   * than on the first customer. Tests pass false — there is no facilitator
   * to ask, and the boot fetch would hang them.
   */
  syncFacilitatorOnStart?: boolean;
  /** Defaults to silent, as in the facilitator. */
  logger?: Logger;
};

/** Builds the app. Never listens (D5). */
export function createApp(deps: MerchantDeps): express.Express {
  const app = express();

  const log = deps.logger ?? silentLogger();

  app.use((req, _res, next) => {
    const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
    log.info({ method: req.method, url: req.url, paid: Boolean(sig) }, "request");
    next();
  });

  //   @x402/express 2.28.0 -> index.d.mts:147
  //   paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart?)
  app.use(
    paymentMiddleware(
      {
        "GET /safety-check": {
          description: "On-chain safety facts for a Solana token mint",
          mimeType: "application/json",
          accepts: {
            scheme: "exact",
            network: SOLANA_DEVNET_CAIP2,
            payTo: deps.payTo,
            // No asset field: "$0.001" resolves to the network's default
            // stablecoin, which on devnet is the USDC mint from Stage 1.
            price: deps.price,
            maxTimeoutSeconds: deps.maxTimeoutSeconds,
          },
        },
      },
      deps.server,
      undefined,
      undefined,
      deps.syncFacilitatorOnStart ?? false,
    ),
  );

  // Only reached once payment is verified. Stub until D14's real
  // implementation: mint authority, freeze authority, Token-2022 permanent
  // delegate and default-frozen state, holder concentration, metadata
  // mutability — classified against published rules, no opaque score.
  app.get("/safety-check", (req, res) => {
    res.json({
      mint: req.query.mint ?? null,
      checked: false,
      note: "stub — real checks come after Stage 2",
    });
  });

  app.use(errorHandler(log));

  return app;
}
