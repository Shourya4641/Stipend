/**
 * A hosted agent with a web face.
 *
 * A browser cannot pay — it has no key. So the "run a payment" button
 * triggers an agent HERE, server-side, and the page watches the result.
 *
 * This role exists because the key has to live somewhere, and neither of
 * the alternatives is acceptable: the facilitator already holds the fee
 * payer, and putting both spending keys in one process means one bug
 * reaches both; the merchant must not be able to pay itself.
 *
 * Its protection is the spend cap, not obscurity. Someone hammering the
 * button exhausts the window and SEES the limit working — which is the
 * feature demonstrating itself.
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { errorHandler, paymentRateLimit } from "../shared/http";
import { silentLogger, type Logger } from "../shared/logger";
import { UpstreamError } from "../shared/errors";
import type { PayResult } from "../agent/pay";

export type DemoDeps = {
  pay: (url: string) => Promise<PayResult>;
  merchantUrl: string;
  /** Injected into the page so the browser knows where to read the ledger. */
  facilitatorPublicUrl: string;
  payer: string;
  logger?: Logger;
};

export function createApp(deps: DemoDeps): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  const log = deps.logger ?? silentLogger();

  /** Where the page gets its configuration, rather than hard-coding a URL. */
  app.get("/config", (_req, res) => {
    res.json({
      facilitatorUrl: deps.facilitatorPublicUrl,
      merchantUrl: deps.merchantUrl,
      payer: deps.payer,
    });
  });

  /**
   * Run one payment.
   *
   * Rate-limited per IP: the spend cap protects the money, this protects
   * ACCESS to the demo, so one visitor cannot consume the whole window in
   * ten seconds while ten judges each want a turn.
   */
  app.post("/pay", paymentRateLimit(), async (req, res, next) => {
    const mint =
      typeof req.query["mint"] === "string" && req.query["mint"].length > 0
        ? req.query["mint"]
        : "So11111111111111111111111111111111111111112";

    try {
      const url = `${deps.merchantUrl}/safety-check?mint=${encodeURIComponent(mint)}`;
      const result = await deps.pay(url);
      log.info({ mint, status: result.status, attempts: result.attempts.length }, "demo payment");
      res.json(result);
    } catch (err) {
      // A failed payment is an ANSWER and comes back in the result above.
      // Reaching here means the merchant or the chain is unreachable,
      // which is an accident.
      next(new UpstreamError("the payment could not be attempted", err));
    }
  });

  const here = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(join(here, "public")));

  app.use(errorHandler(log));
  return app;
}
