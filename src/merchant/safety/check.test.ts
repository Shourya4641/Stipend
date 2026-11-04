import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSafetyCheck, NotAMint } from "./check";
import { Severity } from "./types";

/** A fake RPC. Every shape here was captured from a real devnet response. */
/** Named so a typo in a test option is a compile error, not a silent no-op. */
type FakeOptions = {
  mint?: Record<string, unknown> | null;
  program?: string;
  supply?: string;
  largest?: { amount: string }[];
  largestThrows?: boolean;
  supplyThrows?: boolean;
};

const fakeRpc = (over: FakeOptions = {}) => ({
  getAccountInfo: () => ({
    send: async () => ({
      value:
        over.mint === null
          ? null
          : {
              data: {
                program: over.program ?? "spl-token",
                parsed: {
                  type: "mint",
                  info: {
                    decimals: 6,
                    supply: over.supply ?? "1000000",
                    isInitialized: true,
                    mintAuthority: null,
                    freezeAuthority: null,
                    ...over.mint,
                  },
                },
              },
            },
    }),
  }),
  getTokenSupply: () => ({
    send: async () => {
      if (over.supplyThrows) throw new Error("rpc unavailable");
      return { value: { amount: over.supply ?? "1000000", decimals: 6 } };
    },
  }),
  getTokenLargestAccounts: () => ({
    send: async () => {
      if (over.largestThrows) throw new Error("method disabled by provider");
      return { value: over.largest ?? [{ amount: "10000" }, { amount: "10000" }] };
    },
  }),
});

const run = (over: FakeOptions = {}) => createSafetyCheck(fakeRpc(over) as never)("So11111111111111111111111111111111111111112", "solana:devnet");

describe("authorities", () => {
  test("a live mint authority is a RISK, not a note", async () => {
    // Devnet USDC is exactly this: anyone can print more.
    const r = await run({ mint: { mintAuthority: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } });
    const f = r.findings.find((x) => x.id === "mint_authority")!;
    assert.equal(f.severity, Severity.Risk);
    assert.match(f.observed, /9WzDXwBbmkg8/);
    assert.equal(r.verdict, Severity.Risk);
  });

  test("a live freeze authority is a RISK", async () => {
    const r = await run({ mint: { freezeAuthority: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } });
    assert.equal(r.findings.find((x) => x.id === "freeze_authority")!.severity, Severity.Risk);
  });

  test("both null is clean", async () => {
    const r = await run();
    assert.equal(r.verdict, Severity.Ok);
  });
});

describe("token program and extensions", () => {
  test("Token-2022 alone is CAUTION, not risk", async () => {
    // The program is not dangerous; specific extensions are.
    const r = await run({ program: "spl-token-2022" });
    assert.equal(r.findings.find((x) => x.id === "token_program")!.severity, Severity.Caution);
    assert.equal(r.verdict, Severity.Caution);
  });

  test("a permanent delegate is a RISK", async () => {
    // Someone can move your tokens without your signature. This is the
    // single most dangerous thing a mint can declare.
    const r = await run({
      program: "spl-token-2022",
      mint: { extensions: [{ extension: "permanentDelegate" }] },
    });
    const f = r.findings.find((x) => x.id === "extensions")!;
    assert.equal(f.severity, Severity.Risk);
    assert.match(f.rule, /without your signature/);
  });

  test("a harmless extension is not flagged", async () => {
    const r = await run({
      program: "spl-token-2022",
      mint: { extensions: [{ extension: "metadataPointer" }] },
    });
    assert.equal(r.findings.find((x) => x.id === "extensions")!.severity, Severity.Ok);
  });
});

describe("concentration", () => {
  test("one holder above half the supply is a RISK", async () => {
    const r = await run({ supply: "1000", largest: [{ amount: "600" }, { amount: "100" }] });
    const f = r.findings.find((x) => x.id === "concentration")!;
    assert.equal(f.severity, Severity.Risk);
    assert.match(f.observed, /60\.0%/);
  });

  test("a thin top ten is CAUTION", async () => {
    const r = await run({ supply: "1000", largest: [{ amount: "400" }, { amount: "450" }] });
    assert.equal(r.findings.find((x) => x.id === "concentration")!.severity, Severity.Caution);
  });

  test("an RPC that refuses the call reports UNAVAILABLE, never ok", async () => {
    // Public devnet RPC genuinely does this — getTokenLargestAccounts is
    // expensive and providers restrict it. Absence of evidence must not
    // read as evidence of safety.
    const r = await run({ largestThrows: true });
    const f = r.findings.find((x) => x.id === "concentration")!;
    assert.equal(f.severity, Severity.Unavailable);
    assert.match(f.observed, /did not answer/);
  });

  test("zero supply is OK, not unavailable", async () => {
    // Nothing held means no holder can dominate — a complete answer, not
    // a gap. Distinguishing this from "the RPC refused" matters: wSOL on
    // devnet has zero supply, and calling it unavailable capped the
    // verdict of a spotless mint.
    const r = await run({ supply: "0", largest: [] });
    assert.equal(r.findings.find((x) => x.id === "concentration")!.severity, Severity.Ok);
    assert.equal(r.verdict, Severity.Ok);
  });
});

describe("the verdict", () => {
  test("is the WORST finding, not an average", async () => {
    // Five clean facts must not bury the one that can empty your wallet.
    const r = await run({ mint: { mintAuthority: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } });
    assert.equal(r.findings.filter((f) => f.severity === Severity.Ok).length >= 3, true);
    assert.equal(r.verdict, Severity.Risk);
  });

  test("unavailable caps an otherwise-clean result", async () => {
    // Still true for any finding NOT on the may-be-absent list: we did not
    // finish looking, so we do not say "ok". Concentration is the sole
    // exception, because no provider will answer it for a popular mint.
    const r = await run({ supplyThrows: true });
    assert.equal(r.verdict, Severity.Unavailable);
  });

  test("a real risk outranks unavailable", async () => {
    const r = await run({ largestThrows: true, mint: { freezeAuthority: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } });
    assert.equal(r.verdict, Severity.Risk);
  });
});

describe("input", () => {
  test("a valid address that is not a mint is rejected", async () => {
    await assert.rejects(() => run({ mint: null }), NotAMint);
  });

  test("a malformed address is a NotAMint, not a raw SolanaError", async () => {
    // What a judge gets for a typo in the dashboard. Unconverted this is a
    // SolanaError with no mapping, which the global handler turns into a
    // 500 — "we have a bug" — for what is plainly bad input.
    await assert.rejects(
      () => createSafetyCheck(fakeRpc() as never)("not-an-address", "solana:devnet"),
      NotAMint,
    );
  });
});

describe("serialisation", () => {
  test("the whole report survives JSON.stringify", async () => {
    // kit returns some fields as bigint and JSON.stringify throws on
    // those — the probe script hit exactly this. Express would too, as a
    // 500 on a successful check.
    const r = await run();
    assert.doesNotThrow(() => JSON.stringify(r));
  });
});

describe("what an absent finding may and may not do", () => {
  test("an unanswerable CONCENTRATION does not cap an otherwise clean verdict", async () => {
    // Helius aborts this scan for any widely-held mint, so unavailable is
    // the normal answer for popular tokens. Capping on it would label
    // every well-known token "we could not check this".
    const r = await run({ largestThrows: true });
    assert.equal(r.verdict, Severity.Ok);
    assert.equal(
      r.findings.find((f) => f.id === "concentration")!.severity,
      Severity.Unavailable,
      "still reported, with its reason",
    );
  });

  test("a real risk still outranks everything", async () => {
    const r = await run({ largestThrows: true, mint: { mintAuthority: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } });
    assert.equal(r.verdict, Severity.Risk);
  });
});
