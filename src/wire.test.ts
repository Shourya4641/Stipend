import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deadlineOf,
  parseFacilitatorRequest,
  parsePaymentRequirements,
  WireError,
  NO_DEADLINE,
  ALLOWED_NETWORKS,
} from "./wire";

const NETWORK = ALLOWED_NETWORKS[0]!;

/** A minimal well-formed requirements object. Tests mutate copies of it. */
const reqs = () => ({
  scheme: "exact",
  network: NETWORK as string,
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  amount: "1000",
  payTo: "Df1jvHrA4wHg8UdodAuQUGSv773GcdgeekYkT5MhL9Nq",
  maxTimeoutSeconds: 60,
  extra: { lastValidBlockHeight: "500643712" },
});

const body = () => ({
  paymentPayload: { x402Version: 2, accepted: reqs(), payload: { transaction: "AgAA..." } },
  paymentRequirements: reqs(),
});

describe("parseFacilitatorRequest", () => {
  test("accepts a well-formed body and returns SDK-shaped values", () => {
    const r = parseFacilitatorRequest(body());
    assert.equal(r.paymentRequirements.amount, "1000");
    assert.equal(r.paymentPayload.x402Version, 2);
    // Recursive: the terms the payer signed against are narrowed too.
    assert.equal(r.paymentPayload.accepted.scheme, "exact");
  });

  test("an empty extra is fine — a merchant may send no blockhash", () => {
    const b = body();
    b.paymentRequirements.extra = {} as never;
    assert.doesNotThrow(() => parseFacilitatorRequest(b));
  });

  for (const [label, mutate] of [
    ["body is not an object", () => "hello" as unknown],
    ["payload missing", () => ({ paymentRequirements: reqs() })],
    ["requirements missing", () => ({ paymentPayload: body().paymentPayload })],
    ["payload.x402Version missing", () => { const b = body(); delete (b.paymentPayload as never as Record<string, unknown>)["x402Version"]; return b; }],
    ["payload.accepted missing", () => { const b = body(); delete (b.paymentPayload as never as Record<string, unknown>)["accepted"]; return b; }],
    ["payload.payload missing", () => { const b = body(); delete (b.paymentPayload as never as Record<string, unknown>)["payload"]; return b; }],
    ["requirements.extra missing", () => { const b = body(); delete (b.paymentRequirements as never as Record<string, unknown>)["extra"]; return b; }],
    ["maxTimeoutSeconds missing", () => { const b = body(); delete (b.paymentRequirements as never as Record<string, unknown>)["maxTimeoutSeconds"]; return b; }],
    ["payTo is empty", () => { const b = body(); b.paymentRequirements.payTo = ""; return b; }],
  ] as const) {
    test(`${label} -> WireError`, () => {
      assert.throws(() => parseFacilitatorRequest(mutate()), WireError);
    });
  }
});

describe("amount is validated before the policy sees it", () => {
  // decide() takes a bigint, and the hook does BigInt(amount). If a junk
  // amount reached it, BigInt would throw INSIDE onBeforeSettle, the SDK
  // would turn that into a settle failure, and the classifier would report
  // a refused payment for what is actually a malformed request.
  for (const bad of ["", "12.5", "-1", "1e3", "0x10", "1 000", "abc", " 1"]) {
    test(`amount ${JSON.stringify(bad)} -> WireError`, () => {
      const r = reqs();
      r.amount = bad;
      assert.throws(() => parsePaymentRequirements(r), WireError);
    });
  }

  test("zero is well-formed here; refusing it is the policy's job", () => {
    const r = reqs();
    r.amount = "0";
    assert.equal(parsePaymentRequirements(r).amount, "0");
  });
});

describe("network", () => {
  test("accepts the devnet CAIP-2 id", () => {
    assert.equal(parsePaymentRequirements(reqs()).network, NETWORK);
  });

  test("refuses mainnet — /supported advertises devnet only", () => {
    const r = reqs();
    r.network = "solana";
    assert.throws(() => parsePaymentRequirements(r), WireError);
  });
});

describe("deadlineOf", () => {
  test("reads a string height", () => {
    assert.equal(deadlineOf({ extra: { lastValidBlockHeight: "500643712" } }), 500643712n);
  });

  test("reads a number height", () => {
    assert.equal(deadlineOf({ extra: { lastValidBlockHeight: 1000 } }), 1000n);
  });

  // Every one of these must land on the SAFE side. NO_DEADLINE is
  // unreachable, so the payment can never be classified expired, so the
  // payer is never invited to pay a second time without evidence.
  for (const [label, input] of [
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
    ["no extra", {}],
    ["extra is null", { extra: null }],
    ["no height", { extra: {} }],
    ["height is null", { extra: { lastValidBlockHeight: null } }],
    ["height is not numeric", { extra: { lastValidBlockHeight: "soon" } }],
    ["height is negative", { extra: { lastValidBlockHeight: "-5" } }],
    ["height is an object", { extra: { lastValidBlockHeight: {} } }],
  ] as const) {
    test(`${label} -> NO_DEADLINE, never throws`, () => {
      assert.equal(deadlineOf(input), NO_DEADLINE);
    });
  }

  test("NO_DEADLINE is beyond any height the chain will reach", () => {
    assert.ok(NO_DEADLINE > 10n ** 15n);
  });
});
