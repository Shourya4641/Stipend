/**
 * A short-lived cache of safety reports, keyed by mint.
 *
 * Not an optimisation. The check makes three RPC calls, and public devnet
 * RPC answered the third with 429 during development — a judge clicking
 * the demo twice would hit the same wall. On-chain authorities and
 * extensions change rarely; two minutes of staleness is not a risk, and an
 * unanswerable check during a demo is.
 *
 * In-process and bounded. A shared cache would be a Redis dependency for a
 * demo, and this one dies with the process, which is correct: nothing here
 * is worth surviving a restart.
 */
import type { SafetyReport } from "./types";

export type Cache = ReturnType<typeof createCache>;

export function createCache(ttlMs = 120_000, maxEntries = 500) {
  const entries = new Map<string, { at: number; report: SafetyReport }>();

  return {
    get(mint: string): SafetyReport | undefined {
      const hit = entries.get(mint);
      if (!hit) return undefined;
      if (Date.now() - hit.at > ttlMs) {
        entries.delete(mint);
        return undefined;
      }
      return hit.report;
    },

    set(mint: string, report: SafetyReport): void {
      // Bounded so a stream of distinct mints cannot grow it without
      // limit. Map preserves insertion order, so the first key is the
      // oldest — good enough; an LRU would need bookkeeping this does not
      // earn.
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(mint, { at: Date.now(), report });
    },

    get size(): number {
      return entries.size;
    },
  };
}
