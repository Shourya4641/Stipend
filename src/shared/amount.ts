/**
 * Branded atomic token amounts (D11).
 *
 * `10_000n` is 0.01 USDC ONLY because USDC has 6 decimals. Nothing in the
 * policy knows that, and nothing checked it: a cap written thinking in
 * dollars is a limit a million times off, with no error anywhere. Invisible
 * in review, and on devnet it simply never triggers.
 *
 * The brand makes a raw bigint unassignable where atomic units are expected,
 * so every amount has to pass through a function that made you state the
 * decimals.
 */

declare const AtomicBrand: unique symbol;

/** A bigint that is known to be in a token's smallest unit. */
export type AtomicAmount = bigint & { readonly [AtomicBrand]: true };

/**
 * The ONLY way to produce an AtomicAmount.
 *
 * `decimals` is required and unused at runtime — it exists so the call site
 * has to answer "in what units?" out loud. A reviewer sees the answer; a
 * bare cast would hide the question.
 */
export function toAtomic(value: bigint, decimals: number): AtomicAmount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer 0-18, got ${decimals}`);
  }
  if (value < 0n) throw new RangeError(`atomic amounts cannot be negative: ${value}`);
  return value as AtomicAmount;
}

/** Parse a wire string ("1000") into atomic units. Throws on anything else. */
export function atomicFromString(value: string, decimals: number): AtomicAmount {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`not a decimal integer string: ${JSON.stringify(value)}`);
  }
  return toAtomic(BigInt(value), decimals);
}

/** For display only. Never feed this back into a comparison. */
export function formatAtomic(value: AtomicAmount, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
