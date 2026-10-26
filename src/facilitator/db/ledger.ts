/**
 * Durable record of every settlement (D8, D10).
 *
 * A factory taking its connection, mirroring createChain (D15): tests pass
 * PGlite, production passes postgres.js, nothing is stubbed.
 *
 * ORDERING RULE: recordIntent() runs BEFORE the broadcast. Everything else
 * runs after. A missing row means we definitely did not broadcast; a row
 * that is still `pending` means we might have, and must be reconciled
 * rather than re-signed.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { settlements, type SettlementRow } from "./schema";
import { SettlementState, type SettlementState as State } from "../../shared/enums";
import type { AtomicAmount } from "../../shared/amount";

export type Ledger = ReturnType<typeof createLedger>;

export type IntentInput = {
  paymentId?: string | undefined;
  requestFingerprint: string;
  resourceUrl?: string | undefined;
  payer: string;
  network: string;
  asset: string;
  payTo: string;
  amount: AtomicAmount;
  messageHash: string;
  signedTx: string;
  lastValidBlockHeight: bigint;
};

/** A duplicate the unique indexes caught: this purchase already settled. */
export class DuplicatePayment extends Error {
  constructor(readonly existing: SettlementRow) {
    super(`already settled: ${existing.messageHash} (${existing.state})`);
    this.name = "DuplicatePayment";
  }
}

export function createLedger(db: Db) {
  return {
    /**
     * Write the intent, BEFORE broadcasting.
     *
     * Throws DuplicatePayment if either unique index rejects it — the same
     * signed bytes, or the same payment-identifier for this payer. That is
     * the D10 idempotency check, enforced by the database rather than by a
     * read-then-write that two concurrent requests could both pass.
     */
    async recordIntent(input: IntentInput): Promise<SettlementRow> {
      try {
        const [row] = await db.insert(settlements).values(input).returning();
        return row!;
      } catch (err) {
        // 0.44+ wraps driver errors in DrizzleQueryError, so the Postgres
        // code is on .cause, not on the error itself. Code copied from
        // older examples reads err.code and silently never matches.
        const code = (err as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505") throw err;

        const existing = await this.byMessageHash(input.network, input.messageHash);
        if (existing) throw new DuplicatePayment(existing);

        if (input.paymentId) {
          const byId = await this.byPaymentId(input.payer, input.paymentId);
          if (byId) throw new DuplicatePayment(byId);
        }
        throw err; // a unique violation we do not recognise
      }
    },

    /**
     * Move a row out of `pending`. THE ROW COUNT IS THE ANSWER.
     *
     * `where state = 'pending'` makes this a compare-and-set: if the
     * reconciler resolved it a millisecond ago, this updates zero rows and
     * returns false, and the caller must not proceed as though it won. Two
     * writers cannot both believe they resolved the same payment.
     *
     * .returning().length rather than the driver's row count: typed, and it
     * behaves identically on PGlite in tests.
     */
    async resolve(
      id: bigint,
      state: Exclude<State, "pending">,
      outcome: {
        /** Learned from settle(). Null means nothing was broadcast. */
        txSignature?: string | undefined;
        chainSlot?: bigint | undefined;
        chainError?: unknown;
      } = {},
    ): Promise<boolean> {
      const rows = await db
        .update(settlements)
        .set({
          state,
          txSignature: outcome.txSignature ?? null,
          chainSlot: outcome.chainSlot ?? null,
          chainError: outcome.chainError ?? null,
          resolvedAt: new Date(),
          // signedTx is dropped here: it exists only to rebroadcast an
          // unresolved transaction, and it is the one sensitive column.
          signedTx: null,
        })
        .where(and(eq(settlements.id, id), eq(settlements.state, SettlementState.Pending)))
        .returning({ id: settlements.id });
      return rows.length === 1;
    },

    /**
     * Cumulative spend in a window — the actual spend limit (D12).
     *
     * A per-payment cap is not a spend limit: an agent capped at 0.01 USDC
     * per payment can spend without bound by paying a thousand times.
     *
     * Counts `confirmed` and `pending`. Pending might have landed, and a
     * limit that ignores "might have" is one a crash can walk through.
     */
    async spentSince(payer: string, since: Date): Promise<bigint> {
      const [row] = await db
        .select({
          total: sql<bigint>`coalesce(sum(${settlements.amount}), 0)`.mapWith(BigInt),
        })
        .from(settlements)
        .where(
          and(
            eq(settlements.payer, payer),
            gte(settlements.createdAt, since),
            sql`${settlements.state} in ('confirmed', 'pending')`,
          ),
        );
      return row?.total ?? 0n;
    },

    /** Rows the reconciler must resolve, oldest first. */
    async pending(limit = 100): Promise<SettlementRow[]> {
      return db
        .select()
        .from(settlements)
        .where(eq(settlements.state, SettlementState.Pending))
        .orderBy(settlements.createdAt)
        .limit(limit);
    },

    async byMessageHash(network: string, messageHash: string): Promise<SettlementRow | undefined> {
      const [row] = await db
        .select()
        .from(settlements)
        .where(and(eq(settlements.network, network), eq(settlements.messageHash, messageHash)))
        .limit(1);
      return row;
    },

    async bySignature(network: string, txSignature: string): Promise<SettlementRow | undefined> {
      const [row] = await db
        .select()
        .from(settlements)
        .where(and(eq(settlements.network, network), eq(settlements.txSignature, txSignature)))
        .limit(1);
      return row;
    },

    async byPaymentId(payer: string, paymentId: string): Promise<SettlementRow | undefined> {
      const [row] = await db
        .select()
        .from(settlements)
        .where(and(eq(settlements.payer, payer), eq(settlements.paymentId, paymentId)))
        .limit(1);
      return row;
    },

    /** The dashboard's main query. */
    async recent(limit = 50): Promise<SettlementRow[]> {
      return db.select().from(settlements).orderBy(desc(settlements.createdAt)).limit(limit);
    },
  };
}
