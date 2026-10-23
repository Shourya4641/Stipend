/**
 * Structured logging (D2).
 *
 * Not for prettier output. Log lines are currently strings, and the thing we
 * most need to do with them is QUERY: "show me every payment that reached
 * pending" should be a filter, not a grep. The ledger is about to key on the
 * same values, so logs and rows should share a vocabulary.
 *
 * PURE FUNCTIONS NEVER LOG. classify, decide and the wire parsers return
 * values; the caller logs the result. That keeps them testable with no
 * logger to construct. Where a deeper impure function eventually needs
 * context (ledger writes, the reconciler), use AsyncLocalStorage rather than
 * threading a logger argument through.
 *
 * NEVER log signed transaction bytes or a full payment payload: large, and
 * on mainnet a signed-but-unbroadcast transaction in a log file is a real
 * exposure. Log the attempt id and the message hash instead.
 */
import pino, { type Logger } from "pino";

export type { Logger };

export type LoggerConfig = {
  /** Service name, bound to every line this process emits. */
  service: string;
  level?: string;
  /** Human-readable output. Dev only — production emits JSON. */
  pretty?: boolean;
};

export function createLogger(config: LoggerConfig): Logger {
  return pino({
    name: config.service,
    level: config.level ?? process.env["LOG_LEVEL"] ?? "info",
    ...(config.pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

/**
 * A logger that discards everything. For tests: route tests assert on
 * responses, and 100 lines of log noise per run hides the failures.
 */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
