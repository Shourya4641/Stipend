import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SettlementState, Phase, RefusalKind, SETTLEMENT_STATES } from "./enums";

describe("as const enums behave like plain strings", () => {
  test("a member IS its string, so SDK values assign with no cast", () => {
    // The whole reason for not using the `enum` keyword. A string enum
    // member would not be === its own string from an external source.
    const fromSdk: string = "pending";
    assert.equal(SettlementState.Pending, fromSdk);
  });

  test("values are iterable for exhaustiveness checks", () => {
    assert.equal(SETTLEMENT_STATES.length, 5);
    assert.ok(SETTLEMENT_STATES.includes(SettlementState.Expired));
  });

  test("no two members share a value", () => {
    // A duplicate would silently merge two states and nothing else would
    // notice — classify would return a state the ledger cannot distinguish.
    for (const e of [SettlementState, Phase, RefusalKind]) {
      const values = Object.values(e);
      assert.equal(new Set(values).size, values.length);
    }
  });
});
