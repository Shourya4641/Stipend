/**
 * Reads six facts about a mint and classifies each against a stated rule.
 *
 * A factory taking its chain, like everything else (D15), so tests pass a
 * fake RPC and nothing is stubbed at module level.
 */
import { address, type Address } from "@solana/kit";
import { Severity, type Finding, type SafetyReport } from "./types";

type Rpc = {
  getAccountInfo: (a: Address, c: { encoding: "jsonParsed" }) => { send: () => Promise<any> };
  getTokenSupply: (a: Address) => { send: () => Promise<any> };
  getTokenLargestAccounts: (a: Address) => { send: () => Promise<any> };
};

const TOKEN_2022 = "spl-token-2022";

/** Extensions that let someone else move, freeze or tax your tokens. */
const DANGEROUS_EXTENSIONS: Record<string, string> = {
  permanentDelegate: "a permanent delegate can move your tokens without your signature",
  defaultAccountState: "new accounts can be created frozen, so you may be unable to transfer",
  transferHook: "a program runs on every transfer and can make transfers fail",
  transferFeeConfig: "a fee is deducted from every transfer",
  mintCloseAuthority: "the mint can be closed",
};

export function createSafetyCheck(rpc: Rpc) {
  return async function check(mintAddress: string, network: string): Promise<SafetyReport> {
    // address() throws a SolanaError on anything that is not valid base58
    // of the right length. Unmapped, that becomes a 500 for what is really
    // a typo — so it is converted here, where we know what the input was.
    let mint: Address;
    try {
      mint = address(mintAddress);
    } catch {
      throw new NotAMint(mintAddress);
    }
    const findings: Finding[] = [];

    // ── The mint account: authorities, program, extensions ──────────────
    const info = await rpc.getAccountInfo(mint, { encoding: "jsonParsed" }).send();
    const parsed = info.value?.data?.parsed;
    if (!parsed || parsed.type !== "mint") {
      throw new NotAMint(mintAddress);
    }
    const i = parsed.info;
    const program: string = info.value?.data?.program ?? "unknown";

    findings.push(
      i.mintAuthority
        ? {
            id: "mint_authority",
            severity: Severity.Risk,
            title: "Supply can be increased",
            observed: `mint authority is ${i.mintAuthority}`,
            rule: "A live mint authority can print unlimited new tokens, diluting every holder.",
          }
        : {
            id: "mint_authority",
            severity: Severity.Ok,
            title: "Supply is fixed",
            observed: "mint authority is null",
            rule: "With no mint authority the supply cannot be increased by anyone.",
          },
    );

    findings.push(
      i.freezeAuthority
        ? {
            id: "freeze_authority",
            severity: Severity.Risk,
            title: "Your balance can be frozen",
            observed: `freeze authority is ${i.freezeAuthority}`,
            rule: "A freeze authority can make your token account untransferable at any time.",
          }
        : {
            id: "freeze_authority",
            severity: Severity.Ok,
            title: "Balances cannot be frozen",
            observed: "freeze authority is null",
            rule: "With no freeze authority nobody can immobilise your tokens.",
          },
    );

    findings.push({
      id: "token_program",
      severity: program === TOKEN_2022 ? Severity.Caution : Severity.Ok,
      title: program === TOKEN_2022 ? "Token-2022 mint" : "Classic SPL Token mint",
      observed: `owned by ${program}`,
      rule:
        program === TOKEN_2022
          ? "Token-2022 allows extensions that change transfer behaviour; see the extensions finding."
          : "The classic token program has no extension mechanism, so transfer behaviour is fixed.",
    });

    const extensions: string[] = (i.extensions ?? []).map((e: { extension: string }) => e.extension);
    const dangerous = extensions.filter((e) => e in DANGEROUS_EXTENSIONS);
    findings.push(
      dangerous.length > 0
        ? {
            id: "extensions",
            severity: Severity.Risk,
            title: "Transfer behaviour is modified",
            observed: dangerous.join(", "),
            rule: dangerous.map((e) => DANGEROUS_EXTENSIONS[e]).join("; "),
          }
        : {
            id: "extensions",
            severity: Severity.Ok,
            title: "No transfer-altering extensions",
            observed: extensions.length ? extensions.join(", ") : "none",
            rule: "No extension present that lets a third party move, freeze or tax transfers.",
          },
    );

    // ── Supply ──────────────────────────────────────────────────────────
    // Supply has never failed in practice, but an unguarded throw here
    // loses the five facts already established — and unlike concentration,
    // an unanswerable supply DOES cap the verdict, because it is not a
    // call any provider refuses by design.
    let supply: { value: { amount: string; decimals: number } } | undefined;
    try {
      // Read through the local const, not the outer `let`: TypeScript
      // cannot narrow a variable assigned in one statement and used in
      // the next, and widening it with `!` would hide a real case.
      const got = await rpc.getTokenSupply(mint).send();
      supply = got;
      findings.push({
        id: "supply",
        severity: Severity.Ok,
        title: "Supply",
        // amount, not uiAmount: uiAmount is a float and already lossy at
        // devnet-USDC magnitudes (16286767414633.814 vs ...813037).
        observed: `${got.value.amount} atomic units, ${got.value.decimals} decimals`,
        rule: "Reported for context; supply alone is neither safe nor unsafe.",
      });
    } catch (err) {
      findings.push({
        id: "supply",
        severity: Severity.Unavailable,
        title: "Supply",
        observed: `the RPC did not answer: ${err instanceof Error ? err.message : String(err)}`,
        rule: "Reported as unavailable rather than assumed; concentration cannot be computed either.",
      });
    }
    // ── Concentration. May be unavailable: getTokenLargestAccounts is
    //    expensive and some RPC providers restrict it.
    try {
      if (!supply) throw new Error("supply is unknown, so a share of it cannot be computed");
      const largest = await rpc.getTokenLargestAccounts(mint).send();
      const total = BigInt(supply.value.amount);
      const holders: bigint[] = largest.value.map((h: { amount: string }) => BigInt(h.amount));

      if (total === 0n || holders.length === 0) {
        findings.push({
          id: "concentration",
          // OK, not unavailable. Nothing is held, so no holder can
          // dominate — that is a complete answer, not a gap in what we
          // know. Marking it unavailable capped the verdict of an
          // otherwise spotless mint and read as "the check failed".
          severity: Severity.Ok,
          title: "Holder concentration",
          observed: "nothing is held, so no holder can dominate",
          rule: "Concentration cannot pose a risk when the supply is zero.",
        });
      } else {
        const pct = (n: bigint) => Number((n * 10_000n) / total) / 100;
        const top1 = pct(holders[0]!);
        const top10 = pct(holders.slice(0, 10).reduce((a, b) => a + b, 0n));
        findings.push({
          id: "concentration",
          severity: top1 >= 50 ? Severity.Risk : top10 >= 80 ? Severity.Caution : Severity.Ok,
          title: "Holder concentration",
          // The RPC returns at most 20 accounts, so this is explicitly
          // about the top holders and says nothing about the long tail.
          observed: `largest holder ${top1.toFixed(1)}%, top 10 ${top10.toFixed(1)}% (of ${largest.value.length} largest accounts)`,
          rule: "A single holder above 50% can move the market alone; a top ten above 80% means thin distribution.",
        });
      }
    } catch (err) {
      findings.push({
        id: "concentration",
        severity: Severity.Unavailable,
        title: "Holder concentration",
        observed: `the RPC did not answer: ${err instanceof Error ? err.message : String(err)}`,
        rule: "Reported as unavailable rather than assumed safe — absence of evidence is not evidence.",
      });
    }

    return {
      mint: mintAddress,
      network,
      checkedAt: new Date().toISOString(),
      verdict: worst(findings),
      findings,
    };
  };
}

export class NotAMint extends Error {
  constructor(a: string) {
    super(`${a} is not a valid, initialised token mint address`);
    this.name = "NotAMint";
  }
}

/**
 * The verdict is the WORST finding, not an average.
 *
 * Averaging lets five reassuring facts bury one that can take your money.
 * Unavailable does not lower a real risk but does cap an otherwise-clean
 * result, because we did not finish looking.
 */
/**
 * Findings whose absence must NOT cap the verdict.
 *
 * getTokenLargestAccounts is refused for any widely-held mint — public RPC
 * rate-limits it, and Helius aborts the scan ("accumulated scan results
 * exceeded the limit"). So unavailable is the NORMAL answer for popular
 * tokens, and letting it cap the verdict would mark every well-known token
 * as "we could not check this", which is misleading in the other
 * direction.
 *
 * The finding is still reported with its reason. It simply does not
 * override five facts we did establish.
 */
const MAY_BE_ABSENT = new Set(["concentration"]);

function worst(findings: Finding[]): Severity {
  const rank = { ok: 0, unavailable: 1, caution: 2, risk: 3 } as const;
  return findings.reduce<Severity>((acc, f) => {
    if (f.severity === Severity.Unavailable && MAY_BE_ABSENT.has(f.id)) return acc;
    return rank[f.severity] > rank[acc] ? f.severity : acc;
  }, Severity.Ok);
}
