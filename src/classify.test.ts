import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, resolvePending, SETTLEMENT_STATES } from "./classify";

// The 402 said: valid until block 1000.
const DEADLINE = 1000n;
const INSIDE = 900n;   // chain still inside the window
const PAST = 1100n;    // chain past the deadline

const base = {
  lastValidBlockHeight: DEADLINE,
  currentBlockHeight: INSIDE,
} as const;

describe("classify — nothing broadcast", () => {
  test("verify failed, chain past deadline -> expired, resignable", () => {
    const r = classify({
      ...base,
      currentBlockHeight: PAST,
      phase: "verify",
      ok: false,
      errorText: "Simulation failed: BlockhashNotFound",
    });
    assert.equal(r.state, "expired");
    assert.equal(r.resignable, true);
  });

  test("expiry is decided by block height, NOT by the error text", () => {
    // Chain is past the deadline but the error mentions something else
    // entirely. Still expired: the arithmetic is authoritative.
    const r = classify({
      ...base,
      currentBlockHeight: PAST,
      phase: "verify",
      ok: false,
      errorText: "Simulation failed: InvalidAccountData",
    });
    assert.equal(r.state, "expired");
    assert.equal(r.resignable, true);
  });

  test("verify failed inside the window -> rejected, not resignable", () => {
    // Re-signing identical terms produces an identical refusal.
    const r = classify({
      ...base,
      phase: "verify",
      ok: false,
      errorText: "Simulation failed: InvalidAccountData",
      refusalKind: "terms",
    });
    assert.equal(r.state, "rejected");
    assert.equal(r.resignable, false);
    assert.equal(r.retryableLater, false);
  });

  test("policy refusal is retryableLater but still not resignable now", () => {
    const r = classify({
      ...base,
      phase: "settle",
      ok: false,
      errorText: "daily spend cap reached",
      refusalKind: "policy",
    });
    assert.equal(r.state, "rejected");
    assert.equal(r.resignable, false);
    assert.equal(r.retryableLater, true);
  });

  test("unattributed refusal defaults to the safe side", () => {
    const r = classify({ ...base, phase: "verify", ok: false });
    assert.equal(r.retryableLater, false);
  });

  test("settle failed with NO signature behaves like verify", () => {
    const r = classify({
      ...base,
      currentBlockHeight: PAST,
      phase: "settle",
      ok: false,
    });
    assert.equal(r.state, "expired");
    assert.equal(r.resignable, true);
  });
});

describe("classify — a signature exists", () => {
  test("settle succeeded -> confirmed", () => {
    const r = classify({ ...base, phase: "settle", ok: true, signature: "5T3Ttj…" });
    assert.equal(r.state, "confirmed");
    assert.equal(r.resignable, false);
  });

  test("THE DANGEROUS ONE: broadcast + expiry-looking error -> pending", () => {
    // A signature exists AND the chain is past the deadline AND the error
    // says BlockhashNotFound. Every surface signal screams "expired, retry".
    // It is still pending: those bytes may have landed before expiry, and
    // the only way to know is to ask the chain. Re-signing here pays twice.
    const r = classify({
      ...base,
      currentBlockHeight: PAST,
      phase: "settle",
      ok: false,
      signature: "353svFfRt1…",
      errorText: "BlockhashNotFound",
    });
    assert.equal(r.state, "pending");
    assert.equal(r.resignable, false);
  });

  test("success claimed with no signature -> pending, not confirmed", () => {
    const r = classify({ ...base, phase: "settle", ok: true });
    assert.equal(r.state, "pending");
    assert.equal(r.resignable, false);
  });
});

describe("invariants", () => {
  // The single rule the whole design rests on. Brute-forced over every
  // combination rather than argued: if a signature exists, re-signing is
  // never safe, whatever else is true.
  test("a signature ALWAYS forbids re-signing", () => {
    for (const phase of ["verify", "settle"] as const) {
      for (const ok of [true, false]) {
        for (const height of [INSIDE, PAST]) {
          for (const errorText of [undefined, "BlockhashNotFound", "InvalidAccountData"]) {
            for (const refusalKind of [undefined, "policy", "terms", "unknown"] as const) {
              const r = classify({
                phase,
                ok,
                signature: "sig",
                errorText,
                refusalKind,
                lastValidBlockHeight: DEADLINE,
                currentBlockHeight: height,
              });
              assert.equal(r.resignable, false, `leaked on ${phase}/${ok}/${height}/${errorText}/${refusalKind}`);
              assert.equal(r.retryableLater, false);
            }
          }
        }
      }
    }
  });

  test("resignable implies nothing was broadcast", () => {
    for (const height of [INSIDE, PAST]) {
      for (const ok of [true, false]) {
        const r = classify({
          phase: "settle",
          ok,
          lastValidBlockHeight: DEADLINE,
          currentBlockHeight: height,
        });
        if (r.resignable) assert.equal(r.state, "expired");
      }
    }
  });

  test("every state returned is a declared state", () => {
    const r = classify({ ...base, phase: "verify", ok: false });
    assert.ok(SETTLEMENT_STATES.includes(r.state));
  });
});

describe("resolvePending", () => {
  test("not on chain -> still pending", () => {
    assert.equal(resolvePending("sig", { landed: false, errored: false }).state, "pending");
  });
  test("landed clean -> confirmed", () => {
    assert.equal(resolvePending("sig", { landed: true, errored: false }).state, "confirmed");
  });
  test("landed and errored -> failed, still never resignable", () => {
    const r = resolvePending("sig", { landed: true, errored: true });
    assert.equal(r.state, "failed");
    assert.equal(r.resignable, false);
  });
});
