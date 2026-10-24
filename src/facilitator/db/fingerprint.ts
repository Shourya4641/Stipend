/**
 * A stable hash of the terms a payment was made against (D10).
 *
 * The comparison it enables comes later: same payment-identifier with a
 * DIFFERENT fingerprint means the client changed the terms under a reused
 * id, which is a 409. Computing it from day one means D10 adds only the
 * check, not a backfill — and avoids a column full of placeholders that
 * would silently match everything against everything.
 *
 * Deliberately excludes: the signature, the memo nonce and the blockhash.
 * All three change when a payment is re-signed, and the whole point is that
 * the fingerprint does not.
 */
import { createHash } from "node:crypto";

export type FingerprintTerms = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  resource?: string | undefined;
};

export function fingerprint(terms: FingerprintTerms): string {
  // Field order is fixed and the separator cannot appear in a base58
  // address or a decimal amount, so two different term sets cannot collide
  // by concatenation.
  const canonical = [
    terms.scheme,
    terms.network,
    terms.asset,
    terms.amount,
    terms.payTo,
    terms.resource ?? "",
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}
