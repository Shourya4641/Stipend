import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decide, decideWindow, DEFAULT_POLICY } from "./policy";
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
    assert.equal(decide(atomic(50_000n), { ...DEFAULT_POLICY, maxAtomicPerPayment: atomic(100_000n) }).allowed, true);
  });
});

describe("decideWindow — the cumulative cap", () => {
  const config = { ...DEFAULT_POLICY, windowCapAtomic: atomic(10_000n) };

  test("allows a payment that fits in the remaining budget", () => {
    assert.equal(decideWindow(atomic(1_000n), 8_000n, config).allowed, true);
  });

  test("allows a payment that lands exactly on the cap", () => {
    assert.equal(decideWindow(atomic(2_000n), 8_000n, config).allowed, true);
  });

  test("refuses one unit over", () => {
    const d = decideWindow(atomic(2_001n), 8_000n, config);
    assert.equal(d.allowed, false);
    assert.match(d.allowed === false ? d.reason : "", /window cap/);
  });

  test("THE POINT: many small payments exhaust the budget", () => {
    // What a per-payment cap cannot do. Each of these is far under
    // maxAtomicPerPayment and would pass decide() every time; together
    // they are the whole budget, and the eleventh is refused.
    let spent = 0n;
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const amount = atomic(1_000n);
      if (!decide(amount, config).allowed) break;
      if (!decideWindow(amount, spent, config).allowed) break;
      spent += amount;
      allowed += 1;
    }
    assert.equal(allowed, 10);
    assert.equal(spent, 10_000n);
  });

  test("a spent total already over the cap refuses everything", () => {
    // Possible after the concurrency overshoot documented on decideWindow:
    // two payments racing can take the total past the cap, and the next
    // request must still be refused rather than wrapping around.
    assert.equal(decideWindow(atomic(1n), 99_999n, config).allowed, false);
  });
});
