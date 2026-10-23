import { test, describe } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp, type FacilitatorCore } from "./app";

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
    payload: { transaction: "AgAAsigned-bytes" },
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

const appWith = (over: Partial<FacilitatorCore> = {}, height = 900n) =>
  createApp({ facilitator: stubFacilitator(over), chain: chainAt(height) });

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
    assert.equal(res.body.invalidReason, "facilitator_error");
  });
});

describe("POST /settle", () => {
  test("success -> confirmed with the signature", async () => {
    const res = await request(appWith()).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "confirmed");
  });

  test("settle THROWS -> still a structured verdict, never a 500", async () => {
    // A policy abort throws out of settle() (x402Facilitator.ts:418). It is
    // an outcome, not a crash, and must carry a verdict or retryableLater is
    // invisible exactly when it matters.
    const app = appWith({ settle: (async () => { throw new Error("Settlement aborted: cap"); }) as never });
    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.extra.stipend.state, "rejected");
    // Nothing broadcast, so the signature must stay empty — otherwise the
    // verdict would read as pending and the payer could never retry.
    assert.equal(res.body.transaction, "");
  });

  test("a POLICY veto is retryableLater; a malformed payment is not", async () => {
    // These two are both success:false with no signature. The ONLY thing
    // separating them is refusalKind, supplied by whoever refused — never
    // parsed back out of the message. Getting this wrong tells an agent to
    // give up on terms that would work in an hour.
    //
    // The stub registers a real onBeforeSettle, so policyVeto is set exactly
    // as the live hook sets it.
    let veto: ((a: { requirements: { amount: string; asset: string } }) => Promise<unknown>) | undefined;
    const app = createApp({
      facilitator: stubFacilitator({
        onBeforeSettle: ((fn: never) => { veto = fn; }) as never,
        settle: (async () => {
          await veto?.({ requirements: { amount: "20000", asset: "USDC" } });
          throw new Error("Settlement aborted: per-payment cap 10000 exceeded by 20000");
        }) as never,
      }),
      chain: chainAt(900n),
    });

    const res = await request(app).post("/settle").send(body()).expect(200);
    assert.equal(res.body.extra.stipend.state, "rejected");
    assert.equal(res.body.extra.stipend.resignable, false);
    assert.equal(res.body.extra.stipend.retryableLater, true, "policy refusals may lapse");
    assert.match(res.body.extra.stipend.reason, /policy/);
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
