/**
 * Typed errors so one handler can map them, without `instanceof` chains in
 * routes (D4).
 *
 * The rule: a PAYMENT OUTCOME is never an exception. "Your spend cap was
 * exceeded" is an answer — the system worked and the decision carries
 * structure the payer needs. "Postgres is down" is an accident. `catch`
 * receives an Error with a string in it and every structured field is gone,
 * so throwing an answer destroys it.
 */

/** The request was not a well-formed request. 400. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

/** Our dependency failed; the request was fine. 502 — the status says which end broke. */
export class UpstreamError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "UpstreamError";
  }
}
