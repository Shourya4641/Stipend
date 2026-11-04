import express from "express";
import { paymentMiddleware } from "@x402/express";
import type { x402ResourceServer } from "@x402/core/server";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { errorHandler } from "../shared/http";
import { UpstreamError, WireError } from "../shared/errors";
import { NotAMint } from "./safety/check";
import type { SafetyReport } from "./safety/types";
import type { Cache } from "./safety/cache";
import { silentLogger, type Logger } from "../shared/logger";

export type MerchantDeps = {
  /** The paid resource. Required — there is nothing to sell without it. */
  safetyCheck: (mint: string, network: string) => Promise<SafetyReport>;
  /** Short-lived, because public RPC rate-limits the check. */
  cache: Cache;
  /** Reported in each result so a caller knows which chain was read. */
  network: string;
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
  // Only reached once payment is verified and settled.
  app.get("/safety-check", async (req, res, next) => {
    const mint = String(req.query["mint"] ?? "");
    if (!mint) {
      return next(new WireError("mint query parameter is required"));
    }

    try {
      const cached = deps.cache.get(mint);
      if (cached) {
        log.info({ mint, verdict: cached.verdict, cached: true }, "safety check");
        return res.json(cached);
      }

      const report = await deps.safetyCheck(mint, deps.network);
      deps.cache.set(mint, report);
      log.info({ mint, verdict: report.verdict, cached: false }, "safety check");
      return res.json(report);
    } catch (err) {
      // A bad mint is the CALLER's error, not ours — and the payment has
      // already settled by this point, so the status needs to tell them
      // whether paying again with a corrected address would help.
      if (err instanceof NotAMint) return next(new WireError(err.message));
      return next(new UpstreamError("could not read the mint", err));
    }
  });

  app.use(errorHandler(log));

  return app;
}
