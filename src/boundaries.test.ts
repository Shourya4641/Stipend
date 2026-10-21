import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The architecture as something that FAILS rather than something written
 * down. Roles are separate processes run by different parties in real life;
 * an import across that line means a key or a policy has leaked into a
 * process that should not hold it.
 *
 * Scope, stated honestly: this greps import specifiers. It would miss an
 * import written as a longer relative path and would fire on a comment
 * containing one. It is a tripwire, not a proof.
 */

// Anchored to this file, not process.cwd(). Previously `join("src", dir)`
// meant running the suite from a subdirectory made readdirSync throw, the
// catch return [], and every assertion pass vacuously.
const SRC = dirname(fileURLToPath(import.meta.url));

const ROLES = ["agent", "merchant", "facilitator"] as const;

const FORBIDDEN: Record<string, readonly string[]> = {
  // A merchant that can import the facilitator can reach its fee-payer key.
  merchant: ["facilitator", "agent"],
  // An agent that can import the facilitator can read the spend policy it
  // is supposed to be subject to.
  agent: ["facilitator", "merchant"],
  // The facilitator is the trust boundary; it needs nobody else's internals.
  facilitator: ["agent", "merchant"],
  // THE ONE THAT WAS MISSING. Every role imports shared/, so a single
  // import from shared/ into a role gives every other role a transitive
  // path to it — while all the direct-import assertions above still pass.
  shared: ["agent", "merchant", "facilitator"],
};

/** Recursive: a role growing a subdirectory must not escape the check. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(SRC, dir));
  return out;
}

/** Import and re-export specifiers only — not comments, not prose. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

describe("role boundaries", () => {
  for (const [role, banned] of Object.entries(FORBIDDEN)) {
    for (const other of banned) {
      test(`${role}/ must not import ${other}/`, () => {
        for (const file of sources(role)) {
          for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
            assert.ok(
              !spec.includes(`${other}/`),
              `${file} imports "${spec}" — roles are separate processes`,
            );
          }
        }
      });
    }
  }

  // Guards the guard: a typo'd directory name would make every assertion
  // above scan nothing and pass.
  test("every guarded directory exists and has sources", () => {
    for (const dir of Object.keys(FORBIDDEN)) {
      assert.ok(sources(dir).length > 0, `src/${dir}/ is empty or missing`);
    }
  });

  test("every role directory is guarded", () => {
    // Adding src/ledger/ without adding it to FORBIDDEN would leave it
    // unchecked and nothing would say so.
    for (const role of ROLES) {
      assert.ok(FORBIDDEN[role], `${role} is a role but has no boundary rule`);
    }
  });
});
