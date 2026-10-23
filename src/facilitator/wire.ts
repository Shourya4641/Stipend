/**
 * Narrowing untrusted input from the network into the SDK's own types.
 *
 * Everything the facilitator receives arrives as `any` from express.
 * Narrowing it in one place, with tests, is the difference between a
 * malformed request being REPORTED as malformed and it being misreported as
 * a refused payment.
 *
 * The functions here return @x402/core types, so no caller needs a cast.
 * A cast would put the hole straight back: it asserts a shape rather than
 * checking one.
 *
 * No schema library: the shapes are small, and hand-written narrowing has no
 * dependency to pin, audit or upgrade.
 */
import { createHash } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";

type Network = PaymentRequirements["network"];

/**
 * Networks this facilitator will accept a request for.
 *
 * Also how `network` gets its type without a cast: `find` on a typed list
 * returns a typed element. And it is the right check anyway — /supported
 * advertises devnet only, so anything else is malformed, not unsupported.
 */
export const ALLOWED_NETWORKS: readonly Network[] = [SOLANA_DEVNET_CAIP2];

/**
 * Stands in for a deadline we were never given.
 *
 * Expiry is proven by `currentBlockHeight > lastValidBlockHeight`. With no
 * deadline, expiry is UNPROVABLE — so the sentinel is a height the chain can
 * never reach, keeping such a payment out of `expired` and on the safe side.
 * A 0n default would do the opposite: mark every payment expired and invite
 * the payer to pay again with no evidence the first one died.
 */
export const NO_DEADLINE = 2n ** 64n;

//! Suggestion - Type assertion checks across the project .. no use of unknown or any .. if used then should be justified.

/** The request was not a well-formed request. NOT a payment outcome. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new WireError(`${field} missing or not a non-empty string`);
  }
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new WireError(`${field} missing or not a finite number`);
  }
  return v;
}

function record(v: unknown, field: string): Record<string, unknown> {
  if (!isRecord(v)) throw new WireError(`${field} missing or not an object`);
  return v;
}

/**
 * Atomic token amount: digits only, no sign, no decimal point.
 *
 * Strict here because the spend policy does BigInt(amount). If that throws
 * inside the onBeforeSettle hook, the SDK turns it into a settle failure and
 * the classifier reports a REFUSED PAYMENT when the truth is a malformed
 * request. Validating here is what makes decide()'s bigint parameter honest.
 */
function atomicAmount(v: unknown, field: string): string {
  const s = str(v, field);
  if (!/^\d+$/.test(s)) {
    throw new WireError(`${field} must be a decimal integer string, got ${JSON.stringify(s)}`);
  }
  return s;
}

function network(v: unknown, field: string): Network {
  const s = str(v, field);
  const found = ALLOWED_NETWORKS.find((n) => n === s);
  if (!found) {
    throw new WireError(`${field} ${JSON.stringify(s)} is not a network this facilitator accepts`);
  }
  return found;
}

export function parsePaymentRequirements(v: unknown, path = "paymentRequirements"): PaymentRequirements {
  const r = record(v, path);
  return {
    scheme: str(r["scheme"], `${path}.scheme`),
    network: network(r["network"], `${path}.network`),
    asset: str(r["asset"], `${path}.asset`),
    amount: atomicAmount(r["amount"], `${path}.amount`),
    payTo: str(r["payTo"], `${path}.payTo`),
    maxTimeoutSeconds: num(r["maxTimeoutSeconds"], `${path}.maxTimeoutSeconds`),
    // Required on the SDK type, so absent is malformed — but an EMPTY extra
    // is fine: a 402 without extra.recentBlockhash is unusual, not invalid.
    extra: record(r["extra"], `${path}.extra`),
  };
}

export function parsePaymentPayload(v: unknown, path = "paymentPayload"): PaymentPayload {
  const p = record(v, path);
  return {
    x402Version: num(p["x402Version"], `${path}.x402Version`),
    // Recursive: the terms the payer says they signed against get the same
    // scrutiny as the terms the merchant is asking us to settle.
    accepted: parsePaymentRequirements(p["accepted"], `${path}.accepted`),
    payload: record(p["payload"], `${path}.payload`),
  };
}

/**
 * The deadline the payer signed against, from `extra.lastValidBlockHeight`.
 *
 * Returns NO_DEADLINE for anything it cannot read as a non-negative integer.
 * Never throws: a missing deadline is a normal condition, not a protocol
 * violation — a merchant with no rpcUrl configured simply doesn't send one.
 */
//! Suggestion - Across the entire project .. there are a few places like this where it looks we have over engineered it hence making it difficult to review and understand it. 
export function deadlineOf(requirements: unknown): bigint {
  if (!isRecord(requirements)) return NO_DEADLINE;
  const extra = requirements["extra"];
  if (!isRecord(extra)) return NO_DEADLINE;

  const raw = extra["lastValidBlockHeight"];
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
    return NO_DEADLINE;
  }
  try {
    const d = BigInt(raw);
    return d < 0n ? NO_DEADLINE : d;
  } catch {
    return NO_DEADLINE;
  }
}

export type FacilitatorRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

/**
 * A /verify or /settle body, fully narrowed, or WireError.
 *
 * Throwing here, before any SDK call, is what keeps a malformed request out
 * of the settlement classifier. A body we cannot read is a 400 with no
 * verdict — not a refused payment carrying a verdict that claims the terms
 * were wrong.
 */
export function parseFacilitatorRequest(body: unknown): FacilitatorRequest {
  const b = record(body, "body");
  return {
    paymentPayload: parsePaymentPayload(b["paymentPayload"]),
    paymentRequirements: parsePaymentRequirements(b["paymentRequirements"]),
  };
}

/**
 * A short, stable id for one payment ATTEMPT.
 *
 * Derived rather than supplied: both /verify and /settle receive the same
 * signed transaction, so both compute the same id with no header to pass
 * and nothing for the merchant to keep in sync. @x402/core's only header
 * hook (createAuthHeaders) is keyed by request path, not by payment, so it
 * cannot carry an id that spans the two calls.
 *
 * Scope is deliberately one attempt. A retry after expiry is a DIFFERENT
 * transaction and gets a different id — correct, because it is a different
 * attempt. Linking attempts at the same purchase needs a request-level key
 * (resource + payer), which is the ledger's job, not this.
 *
 * Not security-relevant: it labels log lines. Truncated for readability.
 */
export function attemptId(payload: PaymentPayload): string {
  const tx = payload.payload["transaction"];
  const basis = typeof tx === "string" ? tx : JSON.stringify(payload.payload);
  return createHash("sha256").update(basis).digest("hex").slice(0, 8);
}
