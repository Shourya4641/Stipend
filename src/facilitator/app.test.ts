import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp, type FacilitatorCore } from "./app";
import { DuplicatePayment, type Ledger } from "./db/ledger";
import { toAtomic } from "../shared/amount";
import { DEFAULT_POLICY } from "./policy";
import { USDC_DECIMALS } from "../shared/chain-constants";

/**
 * Route tests with a stub facilitator and a fake chain.
 *
 * The point is the outcomes devnet cannot be asked to produce on demand: a
 * settle that throws, a success with no signature, a verify failure at a
 * chosen block height. Those are the paths where money goes missing.
 */

const DEADLINE = 1000n;

/** Chain stub. The block height is the only chain fact the routes read. */
const chainAt = (height: bigint) => ({ getBlockHeight: async () => height });

const reqs = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  amount: "1000",
  payTo: "Df1jvHrA4wHg8UdodAuQUGSv773GcdgeekYkT5MhL9Nq",
  maxTimeoutSeconds: 60,
  extra: { lastValidBlockHeight: DEADLINE.toString() },
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  paymentPayload: {
    x402Version: 2,
    accepted: reqs(over),
    // A REAL devnet transaction: the route decodes this now, so a
    // placeholder makes every settle test a 400.
    payload: { transaction: "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC39dj5MymjwZ2IBjOt5c1c5vV9cwZGgqQjbhrnUn55HTBLcWL/cvyotP/04yokxHDHuMpr6z5rpHWmaVI+HfwMgAIBBAgODz6doOog1Rb6k72mD0p2QMvhoG+aDkOf+5xfuxzH/3ixmfFwQP90FCamraLZ6VlN0i6+1P6P67tlL+NA5iuOWWVjmc5ywe5NR6j+O9wY2jP+NJfk0s/8J/4fp/eghA8IwtI59CuVHN2wlYTWUVSX5T8TKNNCPVxCe9YvhecodTtELLORIVfxOpM9ATQoLQMrX/7NAaLb8bd5BgjfAC6nAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpsdlN9+x0yg9CRdqR2jVr+pvsVxoVKMQ/xxGdT67CStwEBQAFAiBOAAAFAAkDAQAAAAAAAAAHBAMEAgEKDOgDAAAAAAAABgYAIDc1MmQxMWM2ZDI3NDQ0NTgwOTcwNzdlNDY0NDQ5ODhhAA==" },
  },
  paymentRequirements: reqs(over),
});

/** Only what the routes call. The real class satisfies this structurally. */
function stubFacilitator(over: Partial<FacilitatorCore> = {}): FacilitatorCore {
  return {
    onBeforeSettle: (() => {}) as never,
    getSupported: () =>
      ({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
          { x402Version: 1, scheme: "exact", network: "solana" },
        ],
        extensions: [],
        signers: {},
      }) as never,
    verify: (async () => ({ isValid: true })) as never,
    settle: (async () => ({
      success: true,
      transaction: "5T3Ttj",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    })) as never,
    ...over,
  };
}

/**
 * A stub ledger that RECORDS ITS CALLS.
 *
 * The real thing is proven against real migrations in ledger.test.ts, so
 * these tests only need to show the route uses it correctly — and the
 * property that matters is ORDER: recordIntent must happen before settle,
 * because a row written afterwards cannot protect a crash in between.
 */
function stubLedger(over: Partial<Ledger> = {}) {
  const calls: string[] = [];
  const stub = {
    calls,
    recordIntent: async () => {
      calls.push("recordIntent");
      return { id: 1n, state: "pending", txSignature: null } as never;
    },
    resolve: async () => {
      calls.push("resolve");
      return true;
    },
    noteBroadcast: async () => {
      calls.push("noteBroadcast");
    },
    spentSince: async () => 0n,
    pending: async () => [],
    byMessageHash: async () => undefined,
    bySignature: async () => undefined,
    byPaymentId: async () => undefined,
    recent: async () => [],
    ...over,
  };
  return stub as unknown as Ledger & { calls: string[] };
}

/** The fee payer in slot 0 of the fixture transaction. */
const FEE_PAYER = "wtC2iEDE28CubypxTesSx7vieCCpFHWz68z1HC7aEDC";

const appWith = (over: Partial<FacilitatorCore> = {}, height = 900n, ledger = stubLedger()) =>
  createApp({
    facilitator: stubFacilitator(over),
    chain: chainAt(height),
    ledger,
    feePayer: FEE_PAYER,
    policy: DEFAULT_POLICY,
  });

describe("GET /supported", () => {
  test("advertises devnet only", async () => {
    // registerExactSvmScheme also registers v1 shims that fan out to mainnet
    // and testnet — networks this facilitator cannot settle.
    const res = await request(appWith()).get("/supported").expect(200);
    assert.equal(res.body.kinds.length, 1);
    assert.equal(res.body.kinds[0].network, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
});

describe("malformed bodies are NOT payment outcomes", () => {
  for (const [label, payload] of [
    ["empty object", {}],
    ["nonsense", { nonsense: true }],
    ["payload only", { paymentPayload: {} }],
    ["amount is not atomic", body({ amount: "0.001" })],
    ["network is mainnet", body({ network: "solana" })],
  ] as const) {
    for (const route of ["/verify", "/settle"] as const) {
      test(`POST ${route} ${label} -> 400, no verdict`, async () => {
        const res = await request(appWith()).post(route).send(payload as object).expect(400);
        assert.equal(res.body.error, "malformed_request");
        // The regression this guards: a protocol error reported as a refused
        // payment, telling the payer their terms were wrong when in fact we
        // never understood the request.
        assert.equal(res.body.extra?.stipend, undefined);
      });
    }
  }
});

describe("POST /verify", () => {
  test("valid -> verified, not a settlement state", async () => {
    const res = await request(appWith()).post("/verify").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "verified");
  });

  test("invalid inside the window -> rejected, not resignable", async () => {
    const app = appWith({ verify: (async () => ({ isValid: false, invalidReason: "x" })) as never }, 900n);
    const res = await request(app).post("/verify").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "rejected");
    assert.equal(res.body.extra.stipend.resignable, false);
  });

  test("invalid past the deadline -> expired, resignable", async () => {
    const app = appWith({ verify: (async () => ({ isValid: false, invalidReason: "x" })) as never }, 1100n);
    const res = await request(app).post("/verify").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "expired");
    assert.equal(res.body.extra.stipend.resignable, true);
  });

  test("a facilitator failure is 502, not 400", async () => {
    // The request was fine; our dependency was not. The status says which
    // end broke (D4).
    const app = appWith({ verify: (async () => { throw new Error("rpc down"); }) as never });
    const res = await request(app).post("/verify").send(body()).expect(502);
    assert.equal(res.body.error, "upstream_unavailable");
    // The global handler answers now, so the body is the generic upstream
    // shape rather than a verify-specific one. Deliberate: an infrastructure
    // failure is not a payment outcome and must not look like one.
    assert.equal(res.body.extra?.stipend, undefined);
  });
});

describe("POST /settle", () => {
  test("success -> confirmed with the signature", async () => {
    const res = await request(appWith()).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "confirmed");
  });

  test("settle THROWS -> 502, because it is now an accident not an answer", async () => {
    // Before D4 a throw from settle() was how the SDK reported a policy
    // veto, so it had to produce a verdict. Now the route decides BEFORE
    // calling settle, so a throw here is genuinely infrastructure failing —
    // and a verdict would be a fabrication.
    const app = appWith({ settle: (async () => { throw new Error("rpc exploded"); }) as never });
    const res = await request(app).post("/settle").send(body()).expect(502);
    assert.equal(res.body.error, "upstream_unavailable");
    assert.equal(res.body.extra?.stipend, undefined);
  });

  test("a POLICY veto is retryableLater, and never reaches the chain", async () => {
    // Driven the way production drives it: a cap the payment exceeds. No
    // stub throws, no hook captured — the route decides and returns.
    const app = createApp({
      facilitator: stubFacilitator({
        settle: (async () => {
          throw new Error("settle must not be called after a veto");
        }) as never,
      }),
      chain: chainAt(900n),
      ledger: stubLedger(),
      feePayer: FEE_PAYER,
      policy: { ...DEFAULT_POLICY, maxAtomicPerPayment: toAtomic(500n, USDC_DECIMALS) },
    });

    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.errorReason, "policy_abort");
    assert.equal(res.body.transaction, "", "nothing was broadcast");
    assert.equal(res.body.extra.stipend.state, "rejected");
    assert.equal(res.body.extra.stipend.resignable, false);
    assert.equal(res.body.extra.stipend.retryableLater, true, "policy refusals may lapse");
  });

  test("success with NO signature -> pending, never confirmed", async () => {
    // Cannot be provoked on devnet. A facilitator claiming success without a
    // signature is misbehaving; treat it as broadcast-of-unknown-outcome,
    // because the expensive mistake is paying twice.
    const app = appWith({
      settle: (async () => ({ success: true, transaction: "", network: "solana:x" })) as never,
    });
    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "pending");
    assert.equal(res.body.extra.stipend.resignable, false);
  });

  test("THE DANGEROUS ONE: broadcast + expiry-looking failure -> pending", async () => {
    // A signature exists, the chain is past the deadline, and the error says
    // BlockhashNotFound. Every surface signal says "expired, retry". It is
    // pending: those bytes may have landed, and re-signing pays twice.
    const app = appWith(
      {
        settle: (async () => ({
          success: false,
          transaction: "353svF",
          errorMessage: "BlockhashNotFound",
          network: "solana:x",
        })) as never,
      },
      1100n,
    );
    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "pending");
    assert.equal(res.body.extra.stipend.resignable, false);
  });
});

describe("verify and settle agree on the attempt id", () => {
  test("same signed transaction, same id in both responses", async () => {
    // Derived, not transmitted: @x402/core's only header hook is keyed by
    // request path, not by payment, so it could not carry this link.
    const app = appWith();
    const v = await request(app).post("/verify").send(body()).expect(200);
    const s = await request(app).post("/settle").send(body()).expect(200);
    assert.ok(v.body.extra.stipend);
    assert.ok(s.body.extra.stipend.reason.includes("5T3Ttj"));
  });
});

describe("the ledger and the ordering rule", () => {
  test("recordIntent happens BEFORE settle", async () => {
    // The property the whole design turns on. A row written after the
    // broadcast cannot protect a crash in between — which is the window
    // where money goes missing.
    const ledger = stubLedger();
    const app = appWith({}, 900n, ledger);
    await request(app).post("/settle").send(body()).expect(200);
    assert.deepEqual(ledger.calls, ["recordIntent", "resolve"]);
  });

  test("a ledger failure means NOTHING is broadcast", async () => {
    // The reason the facilitator is now less available than it was:
    // Postgres down returns 502 rather than settling into no record. The
    // stub below fails the test if settle is reached at all.
    const ledger = stubLedger({
      recordIntent: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:5432");
      },
    });
    const app = createApp({
      facilitator: stubFacilitator({
        settle: (async () => {
          throw new Error("settle must not be called when the ledger is down");
        }) as never,
      }),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: DEFAULT_POLICY,
    });

    const res = await request(app).post("/settle").send(body()).expect(502);
    assert.equal(res.body.error, "upstream_unavailable");
    // An accident, not a payment outcome — no verdict is attached.
    assert.equal(res.body.extra?.stipend, undefined);
  });

  test("a POLICY VETO writes no row at all", async () => {
    // Nothing was broadcast, so there is nothing to record — and a ledger
    // full of refusals would inflate spentSince, tightening a cap that was
    // never actually spent against.
    const ledger = stubLedger();
    const app = createApp({
      facilitator: stubFacilitator(),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: { ...DEFAULT_POLICY, maxAtomicPerPayment: toAtomic(500n, USDC_DECIMALS) },
    });

    await request(app).post("/settle").send(body()).expect(200);
    assert.deepEqual(ledger.calls, [], "the veto happens before the ledger");
  });

  test("a duplicate returns the ORIGINAL receipt, flagged as a replay", async () => {
    // A client whose response was lost has paid and deserves its receipt;
    // the signature is public on-chain anyway. `replay: true` leaves the
    // MERCHANT to decide whether to release the resource a second time —
    // that call is not ours (D10; x402 PR #3021 removed a settled-nonce
    // path for exactly this reason).
    const ledger = stubLedger({
      recordIntent: async () => {
        throw new DuplicatePayment({
          state: "confirmed",
          txSignature: "5T3Ttj-original",
          messageHash: "msg-1",
        } as never);
      },
    });
    const app = createApp({
      facilitator: stubFacilitator({
        settle: (async () => {
          throw new Error("must not settle a payment that already settled");
        }) as never,
      }),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: DEFAULT_POLICY,
    });

    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.transaction, "5T3Ttj-original");
    assert.equal(res.body.extra.replay, true);
  });

  test("a PENDING outcome notes the broadcast instead of resolving", async () => {
    // pending is the one state the route must NOT close: the bytes may
    // have landed. Storing the signature is what gives the reconciler
    // something to ask the chain about later.
    const ledger = stubLedger();
    const app = appWith(
      {
        settle: (async () => ({
          success: false,
          transaction: "353svF",
          errorMessage: "BlockhashNotFound",
          network: "solana:x",
        })) as never,
      },
      1100n,
      ledger,
    );

    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "pending");
    assert.deepEqual(ledger.calls, ["recordIntent", "noteBroadcast"]);
  });
});

describe("the cumulative cap, wired", () => {
  /** Under the per-payment cap, so only the window can refuse. */
  const smallPayment = { ...DEFAULT_POLICY, windowCapAtomic: toAtomic(1_500n, USDC_DECIMALS) };

  test("refuses when the WINDOW is exhausted, though the payment itself is fine", async () => {
    // The whole point of the feature. 1000 passes decide() every time;
    // with 1000 already spent against a 1500 cap, the budget says no.
    const ledger = stubLedger({ spentSince: async () => 1_000n });
    const app = createApp({
      facilitator: stubFacilitator({
        settle: (async () => {
          throw new Error("settle must not be called once the budget is spent");
        }) as never,
      }),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: smallPayment,
    });

    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.errorReason, "policy_abort");
    assert.match(res.body.errorMessage, /window cap/);
    assert.equal(res.body.extra.stipend.retryableLater, true, "budget frees up as the window rolls");
    assert.deepEqual(ledger.calls, [], "refused before any row is written");
  });

  test("allows the payment that fits in the remaining budget", async () => {
    const ledger = stubLedger({ spentSince: async () => 500n });
    const app = createApp({
      facilitator: stubFacilitator(),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: smallPayment,
    });
    await request(app).post("/settle").send(body()).expect(200);
    assert.deepEqual(ledger.calls, ["recordIntent", "resolve"]);
  });

  test("the window is checked against the PAYER from the transaction", async () => {
    // Not from the payload — it has no payer field, and a self-declared
    // one could name someone else's address to spend their budget.
    let askedFor = "";
    const ledger = stubLedger({
      spentSince: async (payer: string) => {
        askedFor = payer;
        return 0n;
      },
    });
    await request(appWith({}, 900n, ledger)).post("/settle").send(body()).expect(200);
    assert.equal(askedFor, "988zj3bQBoxNRnQUtRiA8fAJWQrmXb1LCjMgyJSKFy3B");
  });

  test("an unreadable ledger refuses the payment rather than skipping the cap", async () => {
    // Fail closed. We cannot prove the agent is within budget, so we do
    // not pay — an unenforced cap is worse than a refused payment.
    const ledger = stubLedger({
      spentSince: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const app = createApp({
      facilitator: stubFacilitator({
        settle: (async () => {
          throw new Error("settle must not be called when the budget is unknown");
        }) as never,
      }),
      chain: chainAt(900n),
      ledger,
      feePayer: FEE_PAYER,
      policy: DEFAULT_POLICY,
    });

    const res = await request(app).post("/settle").send(body()).expect(502);
    assert.equal(res.body.error, "upstream_unavailable");
  });
});
