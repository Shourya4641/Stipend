import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The architecture, as something that fails rather than something written
 * down. Roles are separate processes run by different parties in real life;
 * an import across that line means a key or a policy has leaked into a
 * process that should not hold it.
 */
const FORBIDDEN: Record<string, string[]> = {
  // A merchant that can import the facilitator can reach its fee-payer key.
  merchant: ["facilitator", "agent"],
  // An agent that can import the facilitator can read the spend policy it
  // is supposed to be subject to.
  agent: ["facilitator", "merchant"],
  // The facilitator is the trust boundary; it needs nobody else's internals.
  facilitator: ["agent", "merchant"],
};

function sources(dir: string): string[] {
  try {
    return readdirSync(join("src", dir))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("src", dir, f));
  } catch {
    return [];
  }
}

describe("role boundaries", () => {
  for (const [role, banned] of Object.entries(FORBIDDEN)) {
    for (const other of banned) {
      test(`${role}/ must not import ${other}/`, () => {
        for (const file of sources(role)) {
          const text = readFileSync(file, "utf8");
          assert.ok(
            !text.includes(`../${other}/`),
            `${file} imports from ${other}/ — roles are separate processes`,
          );
        }
      });
    }
  }

  test("every role directory actually has files", () => {
    // Guards the test itself: a typo'd directory name would make every
    // assertion above vacuously pass.
    for (const role of Object.keys(FORBIDDEN)) {
      assert.ok(sources(role).length > 0, `src/${role}/ is empty`);
    }
  });
});
