import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_POLICY } from "./policy";

describe("spend policy", () => {
  test("allows a payment under the cap", () => {
    assert.equal(decide(1_000n).allowed, true);
  });

  test("allows a payment exactly at the cap", () => {
    // Off-by-one at a boundary is how a cap quietly becomes cap-minus-one.
    assert.equal(decide(DEFAULT_POLICY.maxAtomicPerPayment).allowed, true);
  });

  test("refuses one unit over the cap", () => {
    const d = decide(DEFAULT_POLICY.maxAtomicPerPayment + 1n);
    assert.equal(d.allowed, false);
    assert.match(d.allowed === false ? d.reason : "", /exceeded/);
  });

  test("refuses zero and negative amounts", () => {
    // Not reachable through a well-formed 402, which is why it is worth
    // refusing explicitly rather than letting it through as "under the cap".
    assert.equal(decide(0n).allowed, false);
    assert.equal(decide(-1n).allowed, false);
  });

  test("the cap is configurable per instance", () => {
    assert.equal(decide(50_000n, { maxAtomicPerPayment: 100_000n }).allowed, true);
  });
});
