/**
 * A stable identity for a payment, computable BEFORE it is broadcast.
 *
 * The intent row must be written before the transaction goes to the chain,
 * but a Solana txid IS the fee payer's signature — which the SDK produces
 * inside settle(), at the same moment it broadcasts. By the time we can see
 * it, the thing we were guarding against has already happened.
 *
 * The MESSAGE is everything except signatures, so it is fully determined
 * the instant the agent builds the transaction. Hashing it gives us a key
 * that exists before anyone signs.
 *
 * Deliberately NOT a hash of the whole payload: the signature slots are
 * part of those bytes, and mutating one would produce a different hash for
 * the same payment — bypassing dedup. x402's own Python SDK moved to the
 * message hash for exactly this reason (changelog 2.12.0).
 */
import { createHash } from "node:crypto";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import { WireError } from "../shared/errors";

const base64 = getBase64Encoder();
const decoder = getTransactionDecoder();

/**
 * The transaction was not decodable.
 *
 * Extends WireError so the global handler answers 400: a transaction we
 * cannot parse is a malformed REQUEST, the same category as a missing
 * field — not an internal failure and not a payment outcome.
 */
export class UndecodableTransaction extends WireError {
  constructor(cause: unknown) {
    super(`could not decode the signed transaction: ${String(cause)}`);
    this.name = "UndecodableTransaction";
  }
}

/**
 * sha256 of the compiled transaction message, hex.
 *
 * @param transactionBase64 the `payload.transaction` field of a payment payload
 */
export type PaymentIdentity = {
  /** sha256 of the compiled transaction message, hex. */
  messageHash: string;
  /**
   * Who actually signed — read from the transaction, NOT from the payload.
   *
   * The payload has no payer field at all (verified against @x402/svm
   * 2.28.0: payload.payload contains only `transaction`). Good: a
   * self-declared payer could be set to someone else's address to spend
   * against their budget. The signature map cannot be lied about.
   */
  payer: string;
};

/**
 * Decode once, return both facts the ledger needs.
 *
 * @param transactionBase64 the `payload.transaction` field of a payment payload
 * @param feePayer the address occupying the fee-payer slot, from the 402
 */
export function paymentIdentity(
  transactionBase64: string,
  feePayer: string,
): PaymentIdentity {
  try {
    const tx = decoder.decode(base64.encode(transactionBase64));

    // Every signer except the fee payer. On an x402 exact-svm transaction
    // that is the payer and nobody else — the scheme forbids extra signers.
    const payer = Object.keys(tx.signatures).find((address) => address !== feePayer);
    if (!payer) throw new Error("no signer other than the fee payer");

    return {
      messageHash: createHash("sha256").update(Buffer.from(tx.messageBytes)).digest("hex"),
      payer,
    };
  } catch (err) {
    if (err instanceof UndecodableTransaction) throw err;
    throw new UndecodableTransaction(err);
  }
}

/** Just the hash, for callers that do not need the payer. */
export function messageHash(transactionBase64: string): string {
  try {
    const { messageBytes } = decoder.decode(base64.encode(transactionBase64));
    return createHash("sha256").update(Buffer.from(messageBytes)).digest("hex");
  } catch (err) {
    if (err instanceof UndecodableTransaction) throw err;
    throw new UndecodableTransaction(err);
  }
}
