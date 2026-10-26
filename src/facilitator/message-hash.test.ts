import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { messageHash, UndecodableTransaction } from "./message-hash";

/**
 * A real devnet payment, captured from the agent. Two signature slots: the
 * fee payer's is zeros at this point (the facilitator has not signed yet),
 * the agent's is filled.
 */
const SIGNED_TX =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC39dj5MymjwZ2IBjOt5c1c5vV9cwZGgqQjbhrnUn55HTBLcWL/cvyotP/04yokxHDHuMpr6z5rpHWmaVI+HfwMgAIBBAgODz6doOog1Rb6k72mD0p2QMvhoG+aDkOf+5xfuxzH/3ixmfFwQP90FCamraLZ6VlN0i6+1P6P67tlL+NA5iuOWWVjmc5ywe5NR6j+O9wY2jP+NJfk0s/8J/4fp/eghA8IwtI59CuVHN2wlYTWUVSX5T8TKNNCPVxCe9YvhecodTtELLORIVfxOpM9ATQoLQMrX/7NAaLb8bd5BgjfAC6nAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpsdlN9+x0yg9CRdqR2jVr+pvsVxoVKMQ/xxGdT67CStwEBQAFAiBOAAAFAAkDAQAAAAAAAAAHBAMEAgEKDOgDAAAAAAAABgYAIDc1MmQxMWM2ZDI3NDQ0NTgwOTcwNzdlNDY0NDQ5ODhhAA==";

describe("messageHash", () => {
  test("is stable for the same transaction", () => {
    assert.equal(messageHash(SIGNED_TX), messageHash(SIGNED_TX));
    assert.match(messageHash(SIGNED_TX), /^[0-9a-f]{64}$/);
  });

  test("a TRUNCATED transaction is rejected, not hashed anyway", () => {
    // The decoder is strict, and that strictness is the feature. A lenient
    // decoder would hash whatever bytes it managed to read and return a
    // plausible-looking key that silently matches nothing — dedup that
    // never fires. Found by using a log-truncated fixture by accident.
    assert.throws(() => messageHash(SIGNED_TX.slice(0, 200)), UndecodableTransaction);
  });

  test("the signature slots are NOT part of the hash", () => {
    // The whole reason for hashing the message rather than the payload.
    // Flipping a byte inside a signature must not change the identity of
    // the payment, or an attacker bypasses dedup by mutating the fee-payer
    // slot (x402 Python SDK changelog 2.12.0).
    const bytes = Buffer.from(SIGNED_TX, "base64");
    bytes[10] = bytes[10]! ^ 0xff; // inside the first (fee payer) signature
    assert.equal(messageHash(bytes.toString("base64")), messageHash(SIGNED_TX));
  });

  test("rejects anything it cannot decode", () => {
    for (const bad of ["", "not-base64!!", "AAAA"]) {
      assert.throws(() => messageHash(bad), UndecodableTransaction, `input: ${bad}`);
    }
  });
});
