import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { createLedger, DuplicatePayment, type Ledger, type IntentInput } from "./ledger";
import * as schema from "./schema";
import { toAtomic } from "../../shared/amount";
import { USDC_DECIMALS } from "../../shared/chain-constants";
import { SettlementState } from "../../shared/enums";

/**
 * PGlite: Postgres compiled to WASM, in-process, no server.
 *
 * It runs the REAL migrations, so these tests exercise the actual
 * constraints and the actual trigger — not a hand-written approximation
 * that can drift from what production applies.
 */
let client: PGlite;
let ledger: Ledger;

before(async () => {
  client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  ledger = createLedger(db as never);
});

after(async () => client.close());

beforeEach(async () => {
  await client.exec("truncate settlements restart identity");
});

const atomic = (v: bigint) => toAtomic(v, USDC_DECIMALS);

const intent = (over: Partial<IntentInput> = {}): IntentInput => ({
  requestFingerprint: "fp-aaa",
  payer: "agent-1",
  network: "solana:devnet",
  asset: "usdc-mint",
  payTo: "merchant-1",
  amount: atomic(1_000n),
  messageHash: `msg-${Math.random().toString(36).slice(2)}`,
  signedTx: "AgAAsigned-bytes",
  lastValidBlockHeight: 1_000n,
  ...over,
});

describe("recordIntent", () => {
  test("writes a pending row with the signature known before broadcast", async () => {
    const row = await ledger.recordIntent(intent({ messageHash: "sig-1" }));
    assert.equal(row.state, SettlementState.Pending);
    assert.equal(row.messageHash, "sig-1");
    assert.equal(row.txSignature, null, "unknown until settle() returns");
    assert.equal(row.amount, 1_000n, "numeric(39,0) round-trips as bigint");
    assert.equal(row.resolvedAt, null);
  });

  test("the same transaction MESSAGE can never settle twice", async () => {
    await ledger.recordIntent(intent({ messageHash: "sig-dup" }));
    await assert.rejects(
      () => ledger.recordIntent(intent({ messageHash: "sig-dup" })),
      DuplicatePayment,
    );
  });

  test("the same payment-identifier for one payer is one purchase (D10)", async () => {
    // The whole point: two DIFFERENT transactions, one logical purchase.
    await ledger.recordIntent(intent({ paymentId: "pay_abc", messageHash: "sig-a" }));
    await assert.rejects(
      () => ledger.recordIntent(intent({ paymentId: "pay_abc", messageHash: "sig-b" })),
      DuplicatePayment,
    );
  });

  test("rows with NO payment-identifier do not collide with each other", async () => {
    // Why the unique index is PARTIAL. Without the WHERE, the second null
    // would be rejected and every un-identified payment after the first
    // would fail.
    await ledger.recordIntent(intent({ messageHash: "sig-x" }));
    await assert.doesNotReject(() => ledger.recordIntent(intent({ messageHash: "sig-y" })));
  });

  test("the same payment-identifier for a DIFFERENT payer is a different purchase", async () => {
    await ledger.recordIntent(intent({ paymentId: "pay_shared", payer: "agent-1", messageHash: "s1" }));
    await assert.doesNotReject(() =>
      ledger.recordIntent(intent({ paymentId: "pay_shared", payer: "agent-2", messageHash: "s2" })),
    );
  });

  test("a negative amount is refused by the database, not just the type", async () => {
    await assert.rejects(() =>
      ledger.recordIntent(intent({ amount: -1n as never, messageHash: "sig-neg" })),
    );
  });
});

describe("resolve — the row count IS the answer", () => {
  test("pending -> confirmed succeeds once", async () => {
    const row = await ledger.recordIntent(intent({ messageHash: "sig-c" }));
    assert.equal(await ledger.resolve(row.id, SettlementState.Confirmed, { txSignature: "sig-onchain", chainSlot: 42n }), true);

    const after = await ledger.byMessageHash("solana:devnet", "sig-c");
    assert.equal(after?.state, SettlementState.Confirmed);
    assert.equal(after?.chainSlot, 42n);
    // Unknown at insert, learned from settle(). The row existed before the
    // broadcast; the signature arrives after it.
    assert.equal(after?.txSignature, "sig-onchain");
    assert.ok(after?.resolvedAt);
  });

  test("resolving twice returns false the second time", async () => {
    // Compare-and-set. If the reconciler got there a millisecond earlier,
    // this caller must NOT proceed as though it won.
    const row = await ledger.recordIntent(intent({ messageHash: "sig-race" }));
    assert.equal(await ledger.resolve(row.id, SettlementState.Confirmed), true);
    assert.equal(await ledger.resolve(row.id, SettlementState.Failed), false);

    const after = await ledger.byMessageHash("solana:devnet", "sig-race");
    assert.equal(after?.state, SettlementState.Confirmed, "the first writer's answer stands");
  });

  test("the signed transaction is dropped on resolution", async () => {
    // It exists only to rebroadcast an unresolved transaction, and it is
    // the one genuinely sensitive column.
    const row = await ledger.recordIntent(intent({ messageHash: "sig-drop" }));
    await ledger.resolve(row.id, SettlementState.Confirmed);
    assert.equal((await ledger.byMessageHash("solana:devnet", "sig-drop"))?.signedTx, null);
  });

  test("updated_at moves on resolution, created_at does not", async () => {
    // The trigger from migration 0001, exercised through the real schema.
    const row = await ledger.recordIntent(intent({ messageHash: "sig-ts" }));
    await new Promise((r) => setTimeout(r, 25));
    await ledger.resolve(row.id, SettlementState.Confirmed);

    const after = await ledger.byMessageHash("solana:devnet", "sig-ts");
    assert.deepEqual(after!.createdAt, row.createdAt);
    assert.ok(after!.updatedAt > row.updatedAt, "trigger fired");
  });
});

describe("spentSince — the actual spend limit", () => {
  const since = () => new Date(Date.now() - 60_000);

  test("sums confirmed payments", async () => {
    for (const [i, amt] of [1_000n, 2_500n, 400n].entries()) {
      const r = await ledger.recordIntent(intent({ amount: atomic(amt), messageHash: `sum-${i}` }));
      await ledger.resolve(r.id, SettlementState.Confirmed);
    }
    assert.equal(await ledger.spentSince("agent-1", since()), 3_900n);
  });

  test("PENDING counts as spent", async () => {
    // Deliberate. A pending payment might have landed, and a limit that
    // ignores "might have" is one a crash-and-retry cycle walks through.
    //
    // The cost: a payment that never landed holds budget until the
    // reconciler clears it — which makes the reconciler the thing that
    // RELEASES spending capacity, not just bookkeeping.
    await ledger.recordIntent(intent({ amount: atomic(5_000n), messageHash: "sum-pend" }));
    assert.equal(await ledger.spentSince("agent-1", since()), 5_000n);
  });

  test("expired and rejected do NOT count", async () => {
    const r = await ledger.recordIntent(intent({ amount: atomic(9_000n), messageHash: "sum-exp" }));
    await ledger.resolve(r.id, SettlementState.Expired);
    assert.equal(await ledger.spentSince("agent-1", since()), 0n);
  });

  test("another payer's spending is not ours", async () => {
    const r = await ledger.recordIntent(intent({ payer: "agent-2", messageHash: "sum-other" }));
    await ledger.resolve(r.id, SettlementState.Confirmed);
    assert.equal(await ledger.spentSince("agent-1", since()), 0n);
  });

  test("zero rows is 0n, not null", async () => {
    // coalesce guards this: BigInt(null) throws, and the caller would see a
    // crash where the honest answer is "nothing spent yet".
    assert.equal(await ledger.spentSince("nobody", since()), 0n);
  });

  test("a u64-scale amount survives the round trip", async () => {
    // numeric(39,0), not bigint: Postgres int8 is SIGNED, so this would
    // overflow silently in a bigint column.
    const big = atomic(18_446_744_073_709_551_615n);
    const r = await ledger.recordIntent(intent({ amount: big, messageHash: "sum-u64" }));
    await ledger.resolve(r.id, SettlementState.Confirmed);
    assert.equal(await ledger.spentSince("agent-1", since()), big);
  });
});

describe("queries", () => {
  test("pending() returns unresolved rows oldest first", async () => {
    const a = await ledger.recordIntent(intent({ messageHash: "p-1" }));
    await new Promise((r) => setTimeout(r, 10));
    await ledger.recordIntent(intent({ messageHash: "p-2" }));
    await ledger.resolve(a.id, SettlementState.Confirmed);

    const rows = await ledger.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.messageHash, "p-2");
  });

  test("recent() returns newest first", async () => {
    await ledger.recordIntent(intent({ messageHash: "r-1" }));
    await new Promise((r) => setTimeout(r, 10));
    await ledger.recordIntent(intent({ messageHash: "r-2" }));
    assert.equal((await ledger.recent())[0]?.messageHash, "r-2");
  });
});
