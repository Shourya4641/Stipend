/**
 * Narrowing untrusted request bodies into the SDK's own types (D6).
 *
 * Express hands over `req.body: any`. Narrowing it in one tested place is
 * what separates a malformed request being REPORTED as malformed from it
 * being misreported as a refused payment — before this existed, a bad body
 * threw inside the SDK, landed in the settle catch, and came back
 * classified as rejected(terms).
 *
 * `unknown` appears at exactly one place per input: the signature that
 * receives bytes off a socket. That is the honest type there and it forces
 * narrowing. `unknown` past this boundary is a smell.
 *
 * Types are INFERRED from the schemas, then checked with `satisfies`. The
 * stricter `z.ZodType<PaymentRequirements>` annotation was rejected: it
 * collapses input and output types, so anything with `.default()` or a
 * transform stops compiling — it already broke env.ts, and the branded
 * AtomicAmount in D11 is a transform. `satisfies` catches a field we
 * REMOVED; a field the SDK ADDS is caught by an exhaustive test instead.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SOLANA_DEVNET_CAIP2 } from "@x402/svm";

/** The request was not a well-formed request. NOT a payment outcome. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/**
 * Stands in for a deadline we were never given.
 *
 * Expiry is proven by `currentBlockHeight > lastValidBlockHeight`. With no
 * deadline it is UNPROVABLE, so this is a height the chain can never reach:
 * such a payment stays out of `expired`, the safe side. A 0n default would
 * mark every payment expired and invite paying again with no evidence the
 * first one died.
 */
export const NO_DEADLINE = 2n ** 64n;

/**
 * Atomic token amount: digits only. Strict because the policy does
 * BigInt(amount) — a throw inside onBeforeSettle becomes a settle failure,
 * and the classifier then reports a REFUSED PAYMENT for a malformed request.
 */
const atomicAmount = z
  .string()
  .regex(/^\d+$/, 'must be a decimal integer string, e.g. "1000"');

/**
 * Only the network /supported advertises. Anything else is malformed, not
 * merely unsupported — and z.literal gives `network` its type with no cast.
 */
const network = z.literal(SOLANA_DEVNET_CAIP2);

const requirementsSchema = z.object({
  scheme: z.string().min(1),
  network,
  asset: z.string().min(1),
  amount: atomicAmount,
  payTo: z.string().min(1),
  // Required on the SDK type, so absent is malformed.
  maxTimeoutSeconds: z.number().finite(),
  // Required too — but an EMPTY extra is fine: a merchant with no rpcUrl
  // configured simply sends no recentBlockhash.
  extra: z.record(z.unknown()),
});

const payloadSchema = z.object({
  x402Version: z.number().finite(),
  accepted: requirementsSchema,
  payload: z.record(z.unknown()),
});

const facilitatorRequestSchema = z.object({
  paymentPayload: payloadSchema,
  paymentRequirements: requirementsSchema,
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  // zod gives field paths for free — the reason the hand-written version
  // threaded a `path` argument through every function.
  throw new WireError(
    r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  );
}

export function parsePaymentRequirements(v: unknown): PaymentRequirements {
  return parse(requirementsSchema, v) satisfies PaymentRequirements;
}

export function parsePaymentPayload(v: unknown): PaymentPayload {
  return parse(payloadSchema, v) satisfies PaymentPayload;
}

export type FacilitatorRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

/**
 * A /verify or /settle body, fully narrowed, or WireError.
 *
 * Throwing here, before any SDK call, is what keeps a malformed request out
 * of the settlement classifier.
 */
export function parseFacilitatorRequest(body: unknown): FacilitatorRequest {
  return parse(facilitatorRequestSchema, body) satisfies FacilitatorRequest;
}

/**
 * The deadline the payer signed against.
 *
 * Never throws: a missing deadline is a normal condition, not a protocol
 * violation. Separate from the schema because it is read from `extra`,
 * which is deliberately untyped.
 */
export function deadlineOf(requirements: unknown): bigint {
  const parsed = z
    .object({ extra: z.object({ lastValidBlockHeight: z.union([z.string(), z.number()]) }) })
    .safeParse(requirements);
  if (!parsed.success) return NO_DEADLINE;
  try {
    const d = BigInt(parsed.data.extra.lastValidBlockHeight);
    return d < 0n ? NO_DEADLINE : d;
  } catch {
    return NO_DEADLINE;
  }
}

/**
 * A short, stable id for one payment ATTEMPT.
 *
 * Derived, not supplied: @x402/core's only header hook (createAuthHeaders)
 * is keyed by request PATH, not by payment, so a merchant using it would
 * produce one id for /verify and another for /settle — exactly the link we
 * wanted. Both endpoints receive the same signed transaction, so both
 * compute the same id with nothing transmitted.
 *
 * Scope is one attempt. A retry after expiry is a different transaction and
 * gets a different id; linking attempts at one purchase is D10's job.
 */
export function attemptId(payload: PaymentPayload): string {
  const tx = payload.payload["transaction"];
  return createHash("sha256").update(String(tx)).digest("hex").slice(0, 8);
}
