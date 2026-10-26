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

const base64 = getBase64Encoder();
const decoder = getTransactionDecoder();

/** The transaction was not decodable. A malformed request, not an outcome. */
export class UndecodableTransaction extends Error {
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
export function messageHash(transactionBase64: string): string {
  try {
    // Not annotated as Uint8Array: kit types messageBytes as a
    // ReadonlyUint8Array so transaction bytes cannot be mutated in place.
    // Widening it would cast away that guarantee for nothing — createHash
    // only reads.
    const { messageBytes } = decoder.decode(base64.encode(transactionBase64));
    // Buffer.from copies. Node's update() wants a MUTABLE Uint8Array and
    // kit's branded ReadonlyUint8Array does not satisfy that — a cast would
    // claim mutability we were given specifically to not have. A few
    // hundred bytes is not worth lying about.
    return createHash("sha256").update(Buffer.from(messageBytes)).digest("hex");
  } catch (err) {
    if (err instanceof UndecodableTransaction) throw err;
    throw new UndecodableTransaction(err);
  }
}
