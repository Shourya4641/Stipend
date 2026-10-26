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
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { SETTLEMENT_STATES, SettlementState } from "../../shared/enums";

export const settlements = pgTable(
  "settlements",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),

    // ── identity ─────────────────────────────────────────────────────────
    /** Client-generated, one per logical purchase. Survives a re-sign (D10). */
    paymentId: text("payment_id"),
    /**
     * sha256 of the canonical terms (scheme, network, asset, amount, payTo,
     * resource). Computed from day one — D10 later adds the COMPARISON
     * ("same payment id, different terms -> 409"), not the value.
     */
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
     * near its maximum overflows silently. mode:"bigint" maps through
     * BigInt/String, so no customType is needed.
     */
    amount: numeric("amount", { precision: 39, scale: 0, mode: "bigint" }).notNull(),

    // ── the transaction ──────────────────────────────────────────────────
    /**
     * The payment's identity BEFORE it is broadcast: sha256 of the compiled
     * transaction message. The message is everything except signatures, so
     * it is fixed the moment the agent builds the transaction — unlike the
     * txid, which is the fee payer's signature and appears inside settle().
     */
    messageHash: text("message_hash").notNull(),
    /**
     * NULLABLE: unknown at insert, filled in when settle() returns. A row
     * with a null signature is one we may or may not have broadcast.
     */
    txSignature: text("tx_signature"),
    /**
     * The signed bytes, so a pending transaction can be rebroadcast if it
     * never reached a validator. NULLed once the row resolves — it is the
     * one genuinely sensitive column and there is no reason to keep it.
     */
    signedTx: text("signed_tx"),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }).notNull(),

    // ── outcome ──────────────────────────────────────────────────────────
    state: text("state", { enum: SETTLEMENT_STATES })
      .notNull()
      .default(SettlementState.Pending),
    chainSlot: bigint("chain_slot", { mode: "bigint" }),
    chainError: jsonb("chain_error"),
    /** A retry counter. Single digits — integer, not bigint. */
    attempts: integer("attempts").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Maintained by a trigger (see migration 0001). Never set by hand. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * The duplicate guard that fires AT INSERT, before anything is sent.
     * This is the one that prevents double payment.
     */
    uniqueIndex("settlements_message_hash_uq").on(t.network, t.messageHash),

    /**
     * Kept as a second guard, now PARTIAL because the column is nullable.
     * It can no longer fire at insert, but it catches two different
     * messages somehow landing the same on-chain signature — which should
     * be impossible and would be serious if it happened.
     */
    uniqueIndex("settlements_signature_uq")
      .on(t.network, t.txSignature)
      .where(sql`${t.txSignature} is not null`),

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

    /** The dashboard's main query: the most recent settlements. */
    index("settlements_created_at_idx").on(t.createdAt),

    /**
     * text({ enum }) narrows the TYPE only — it does not check at runtime.
     * This is the database half, built from the same array so the two cannot
     * drift. sql.raw because DDL cannot take bound parameters: a plain ${}
     * would emit $1 and the constraint would be meaningless.
     */
    check(
      "settlements_state_check",
      sql`${t.state} in (${sql.raw(SETTLEMENT_STATES.map((s) => `'${s}'`).join(", "))})`,
    ),

    /** Amounts are unsigned. The column type permits 39 digits; the domain does not. */
    check("settlements_amount_unsigned", sql`${t.amount} >= 0`),
  ],
);

export type SettlementRow = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
