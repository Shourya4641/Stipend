/**
 * The settlement ledger.
 *
 * THE RULE THIS TABLE EXISTS FOR: a row is written BEFORE the broadcast,
 * never after. The gap between "bytes sent to the chain" and "response
 * received" is where money goes missing — crash there with no row and a
 * payment may have landed with nothing recording it, so the agent retries
 * and pays twice.
 *
 * Writing first is possible because the facilitator IS the fee payer: a
 * Solana txid is the first signature on the transaction, which is ours, so
 * we know it before sending.
 *
 *   no row            -> we definitely did not broadcast
 *   row, unresolved   -> we might have. Ask the chain; never re-sign.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { SETTLEMENT_STATES } from "../../shared/enums";

export const settlements = pgTable(
  "settlements",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),

    // ── identity ─────────────────────────────────────────────────────────
    /** Client-generated, one per logical purchase. Survives a re-sign (D10). */
    paymentId: text("payment_id"),
    /** sha256 of the canonical terms. Same id + different terms = 409. */
    requestFingerprint: text("request_fingerprint").notNull(),
    /** What was bought. The merchant's view, for the dashboard. */
    resourceUrl: text("resource_url"),
    payer: text("payer").notNull(),

    // ── terms ────────────────────────────────────────────────────────────
    network: text("network").notNull(),
    asset: text("asset").notNull(),
    payTo: text("pay_to").notNull(),
    /**
     * numeric(39,0), not bigint. Postgres `bigint` is SIGNED int8, so a u64
     * near its maximum overflows it silently. 39 digits covers any u128.
     * mode:"bigint" maps through BigInt/String, so no customType is needed.
     */
    amount: numeric("amount", { precision: 39, scale: 0, mode: "bigint" }).notNull(),

    // ── the transaction ──────────────────────────────────────────────────
    /** Known BEFORE broadcast: it is the fee payer's own signature. */
    txSignature: text("tx_signature").notNull(),
    /**
     * The signed bytes, so a pending transaction can be rebroadcast if it
     * never reached a validator. NULLed once the row resolves — it is the
     * one genuinely sensitive column and there is no reason to keep it.
     */
    signedTx: text("signed_tx"),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }).notNull(),

    // ── outcome ──────────────────────────────────────────────────────────
    state: text("state", { enum: SETTLEMENT_STATES }).notNull().default("pending"),
    chainSlot: bigint("chain_slot", { mode: "bigint" }),
    chainError: jsonb("chain_error"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    /** The same signed bytes can never settle twice. */
    uniqueIndex("settlements_signature_uq").on(t.network, t.txSignature),

    /**
     * One settlement per logical purchase (D10). PARTIAL, because rows with
     * no payment-identifier must not collide with each other.
     */
    uniqueIndex("settlements_payment_id_uq")
      .on(t.payer, t.paymentId)
      .where(sql`${t.paymentId} is not null`),

    /** The reconciler's sweep: unresolved rows, oldest first. */
    index("settlements_pending_idx").on(t.createdAt).where(sql`${t.state} = 'pending'`),

    /** Cumulative spend per payer per window — the actual spend limit. */
    index("settlements_payer_time_idx").on(t.payer, t.createdAt),

    /**
     * text({ enum }) narrows the TYPE only — it does not check at runtime.
     * This is the database half, built from the same array so the two
     * cannot drift. sql.raw because DDL cannot take bound parameters: a
     * plain ${} would emit $1 and fail.
     */
    check(
      "settlements_state_check",
      sql`${t.state} in (${sql.raw(SETTLEMENT_STATES.map((s) => `'${s}'`).join(", "))})`,
    ),

    /** Amounts are unsigned. The type permits 39 digits; the domain does not. */
    check("settlements_amount_unsigned", sql`${t.amount} >= 0`),
  ],
);

export type SettlementRow = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
