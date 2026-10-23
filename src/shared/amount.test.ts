import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toAtomic, atomicFromString, formatAtomic } from "./amount";
import { USDC_DECIMALS } from "./chain-constants";

describe("AtomicAmount", () => {
  test("a branded amount is still a bigint at runtime", () => {
    // The brand is types-only; comparisons and arithmetic are unchanged.
    assert.equal(toAtomic(10_000n, 6), 10_000n);
    assert.equal(toAtomic(10_000n, 6) > 9_999n, true);
  });

  test("parses a wire amount", () => {
    assert.equal(atomicFromString("1000", USDC_DECIMALS), 1000n);
  });

  for (const bad of ["", "12.5", "-1", "1e3", "0x10", " 1", "abc"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => atomicFromString(bad, USDC_DECIMALS), RangeError);
    });
  }

  test("rejects nonsense decimals", () => {
    assert.throws(() => toAtomic(1n, -1), RangeError);
    assert.throws(() => toAtomic(1n, 1.5), RangeError);
  });

  test("rejects a negative amount", () => {
    assert.throws(() => toAtomic(-1n, 6), RangeError);
  });

  test("formats for display", () => {
    assert.equal(formatAtomic(toAtomic(10_000n, 6), USDC_DECIMALS), "0.010000");
    assert.equal(formatAtomic(toAtomic(1n, 6), USDC_DECIMALS), "0.000001");
  });
});
