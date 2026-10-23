/**
 * Route plumbing shared by the facilitator and merchant (D4).
 */
import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { UpstreamError, WireError } from "./errors";
import { silentLogger, type Logger } from "./logger";

/**
 * Validate the body and hand the handler a TYPED third argument.
 *
 * Not `app.post(path, validate(schema), handler)` — stashing the result on
 * `req.validated` cannot be typed without augmenting Express's Request
 * globally, which forces a cast and breaks D6.
 *
 * A rejected promise goes to Express 5's error middleware automatically.
 * Express 4 did not do this, which is why every tutorial wraps handlers in
 * try/catch.
 */
export function withBody<T>(
  schema: z.ZodType<T>,
  handler: (req: Request, res: Response, body: T) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new WireError(
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        ),
      );
    }
    return handler(req, res, parsed.data);
  };
}

/**
 * Registered LAST. Express needs exactly four parameters or it treats this
 * as ordinary middleware and never calls it.
 */
export function errorHandler(logger: Logger = silentLogger()) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof WireError) {
      // Safe to echo: we wrote this message.
      logger.warn({ err: err.message }, "malformed request");
      res.status(400).json({ error: "malformed_request", message: err.message });
      return;
    }
    if (err instanceof UpstreamError) {
      logger.error({ err: err.message, cause: err.cause }, "upstream failed");
      res.status(502).json({ error: "upstream_unavailable" });
      return;
    }
    // Never echoed: a 500's message may carry a connection string or a path.
    logger.error({ err }, "unhandled");
    res.status(500).json({ error: "internal" });
  };
}

/**
 * A facilitator in an unknown state is worse than a dead one. Once the
 * ledger exists the intent row survives the crash and a reconciler finishes
 * the job; staying alive is how you get a second broadcast.
 */
export function exitOnFatal(): void {
  for (const signal of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(signal, (err) => {
      console.error(`[fatal] ${signal}`, err);  // console on purpose: the logger may be the thing that died
      process.exit(1);
    });
  }
}
