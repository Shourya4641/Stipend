import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_POLICY } from "./policy";
import { toAtomic } from "../shared/amount";
import { USDC_DECIMALS } from "../shared/chain-constants";

/** Every amount in these tests states its units, as production must. */
const atomic = (v: bigint) => toAtomic(v, USDC_DECIMALS);

describe("spend policy", () => {
  test("allows a payment under the cap", () => {
    assert.equal(decide(atomic(1_000n), DEFAULT_POLICY).allowed, true);
  });

  test("allows a payment exactly at the cap", () => {
    // Off-by-one at a boundary is how a cap quietly becomes cap-minus-one.
    assert.equal(decide(DEFAULT_POLICY.maxAtomicPerPayment, DEFAULT_POLICY).allowed, true);
  });

  test("refuses one unit over the cap", () => {
    const d = decide(atomic(DEFAULT_POLICY.maxAtomicPerPayment + 1n), DEFAULT_POLICY);
    assert.equal(d.allowed, false);
    assert.match(d.allowed === false ? d.reason : "", /exceeded/);
  });

  test("refuses zero", () => {
    // Not reachable through a well-formed 402, so worth refusing explicitly
    // rather than letting it pass as "under the cap".
    assert.equal(decide(atomic(0n), DEFAULT_POLICY).allowed, false);
  });

  test("a negative amount cannot reach the policy at all", () => {
    // toAtomic refuses it at construction, so decide never sees one. The
    // brand moved this check out of the money decision and into the type.
    assert.throws(() => atomic(-1n), RangeError);
  });

  test("the cap is configurable per instance", () => {
    assert.equal(decide(atomic(50_000n), { maxAtomicPerPayment: atomic(100_000n) }).allowed, true);
  });
});
