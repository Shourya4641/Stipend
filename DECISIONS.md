# Review decisions — October 2026

Decisions taken during the code review. **Nothing here is implemented yet.**
All of it lands in one implementation stage at the end of the review.

---

## D1 — No `enum` keyword; `as const` objects instead

TypeScript string enums are *nominally* typed: a plain `string` from
`@x402/core` is not assignable to an enum member without a cast. This code
reads strings off the wire constantly (`network`, `scheme`, `invalidReason`,
`errorReason`), so `enum` would require a cast at every boundary — the exact
thing D6 is meant to remove. `const enum` is already impossible here:
`isolatedModules: true` forbids it.

```ts
export const Phase = { Verify: "verify", Settle: "settle" } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];
```

Gives autocomplete, a usable type, `Object.values()` for tests, and direct
comparison with SDK strings.

Supporting (not decisive, since we run tsx): TS 5.8's `erasableSyntaxOnly`
forbids `enum`, because Node's native type stripping rejects it outright.

**Placement:** vocabulary crossing role boundaries (`SettlementState`,
`Phase`, `RefusalKind`) → `src/shared/enums.ts`. Values used by one role only
→ an enums/constants file inside that role's folder. Shared means shared, not
"all constants in one pile".

**Touches:** shared/classify.ts, facilitator/server.ts, facilitator/wire.ts,
agent/client.ts.

---

## D2 — Structured logging with pino, request-scoped child loggers

Not for prettier output. Log lines are currently strings, and the thing we
most need to do with them is *query*: "show me every payment that reached
pending" should be a filter, not a grep. The ledger is about to key on the
same values, so logs and rows should share a vocabulary.

- `pino`, with `pino-pretty` as a **dev-only** transport.
- `src/shared/logger.ts` exports the factory; each role makes a child with its
  own `service` field.
- Routes bind `attemptId` once via `log.child({ attemptId })`, so
  `[verify ae35d3ed]` and `[settle ae35d3ed]` become a join rather than two
  lines that happen to look alike.
- Levels: `info` for normal verify/policy/settle; `warn` for malformed
  requests and policy vetoes; `error` for thrown settles and dead RPC;
  `debug` for the stall harness.

**Pure functions never log.** `classify`, `decide` and the wire parsers return
values; the caller logs the result. Keeps them testable with no logger to
construct. Where a deeper impure function needs context (ledger writes, the
reconciler), use Node's `AsyncLocalStorage` rather than threading a logger
argument through.

**Never log:** signed transaction bytes or the full payment payload. Large,
and on mainnet a signed-but-unbroadcast transaction in a log file is a real
exposure. Log the message hash and attempt id instead.

**Out of scope for 2 Nov:** a `/metrics` endpoint. Note as a known gap in the
README.

---

## D3 — Config: three kinds, validated once per role with zod

"Constants" is three different things, with three different answers.

**1. Chain facts** — `USDC_MINT`, `SOLANA_DEVNET_CAIP2`, token program id.
Protocol truths, not configuration. **Shared**, frozen, and deliberately NOT
env-overridable: `process.env.DEVNET_USDC_MINT` would invite pointing a
devnet build at an arbitrary mint with nothing downstream noticing.
→ `src/shared/chain-constants.ts`

**2. Deployment config** — ports, service URLs, RPC endpoint, `DATABASE_URL`.
Genuinely varies, must be validated. **Per-role.**
→ `src/<role>/config.ts`

**3. Secrets** — fee-payer key, DB password inside `DATABASE_URL`.
**Per-role, and this is a security boundary, not tidiness.** A shared config
object means the agent process can read the key that spends SOL.
`boundaries.test.ts` already forbids `agent/` importing `facilitator/`; a
shared config is the hole in that fence, because the secret arrives via
`shared/`. Same invariant, applied to data instead of code.

### Validation

- **zod**, for env AND for `wire.ts` — see D6. Using zod for one and
  hand-rolling the other is the inconsistency that makes a codebase feel
  arbitrary. zod also gives field paths in errors for free, which is the
  `path` threading currently hand-built in wire.ts.
- Schemas must end in `satisfies` against the `@x402/core` types, so SDK
  drift fails at compile time rather than at runtime.

### Loading

- Each role's `config.ts` exports **`loadConfig()`** — it does NOT parse at
  import time. Importing the module must have no side effects, or every test
  and tool that touches it needs a full env to exist.
- The role's entrypoint calls `loadConfig()` once at startup and passes the
  result down. Tests construct a config literal and never touch
  `process.env`; this is also what makes supertest route tests practical.
- On failure: report **every** missing/invalid variable at once and exit.
  One-per-restart discovery is a waste of a session.

### Defaults

- Devnet RPC URL and localhost ports MAY default — the default is the safe case.
- Secrets and `DATABASE_URL` have **NO default**. Absent means refuse to start.
  A silent default here means connecting to the wrong database and finding out
  via corrupt rows.
- `.env.example` lists every variable, including the ones with no default, or
  a fresh clone fails citing a variable nobody documented.

---

## D4 — Errors: answers are returns, accidents are exceptions

**The rule:** some things that go wrong are *answers* ("your spend cap was
exceeded" — the system worked, we decided no, and that decision carries
structure the agent needs). Some are *accidents* ("Postgres is down" — there
is no answer, only a failure).

**An answer must never travel as an exception.** `catch` receives an `Error`
with a string in it; every structured field is gone. `retryableLater: true`
disappears precisely when it matters.

### Four classes

| Class | Example | Status | Verdict? | Where |
|---|---|---|---|---|
| Protocol error | body is not a valid request | 400 | No — never a payment | Global handler |
| Payment outcome | verify failed, policy veto, settle failed | 402 / 200 | **Always** | In-route, as a `return` |
| Infrastructure | RPC down, Postgres unreachable | 502 | No | Global handler |
| Programmer error | `undefined is not a function` | 500 | No, message never leaked | Global handler |

Today's `/settle` catch does classes 2 and 4 at once: a policy abort and a
genuine bug land in the same branch, and a crash is reported to the agent as
`rejected (policy)` if `policyVeto` happens to be set from an earlier request.

### Move the policy check into the route

`onBeforeSettle` returning `{ abort }` THROWS out of `facilitator.settle()`
(x402Facilitator.ts:418). Stop using that throw as the signal — `decide()`
already told us, in the hook, and we discard it only to infer it back from an
exception.

```ts
const decision = decide(BigInt(body.paymentRequirements.amount), config.policy);
if (!decision.allowed) {
  return reply(res, log, { ok: false, signature: "", refusalKind: "policy",
                           errorText: decision.reason });
}
const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
```

Consequences:
- **`policyVeto` is deleted**, not fixed. The module-level variable and its
  concurrent-settle race go away, because the decision is made and used three
  lines apart.
- The hook stays registered as **defence in depth** — it still fires if the
  SDK is driven from elsewhere — but nothing depends on catching it.
- Accepted cost: the decision now exists in two places (route and hook) and
  they must agree. Both call the same `decide()`, so divergence means someone
  edited one call site; a test asserts they return the same answer.
- Anything `settle()` still throws is class 3 or 4, so the catch block goes
  away entirely. **Express 5 forwards rejected promises from async handlers to
  the error middleware automatically** (Express 4 did not — that is why
  tutorials wrap every handler).

### Global error handler

Registered last. Express requires **exactly four** parameters or it treats the
function as ordinary middleware and never calls it.

```ts
WireError      → 400  { error: "malformed_request", message }   // we wrote it; safe to echo
UpstreamError  → 502  { error: "upstream_unavailable" }
anything else  → 500  { error: "internal" }                      // logged, never sent
```

A 500's message may contain a connection string or a file path. Never echo it.

### Body validation at the route

NOT `app.post(path, validate(schema), handler)` — stashing on `req.validated`
cannot be typed without augmenting Express's `Request` globally, which forces
a cast and breaks D6.

A wrapper passes the parsed body as a typed third argument:

```ts
function withBody<T>(schema: z.ZodType<T>, handler: (req, res, body: T) => Promise<void>) {
  return async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return next(new WireError(formatZodError(parsed.error)));
    return handler(req, res, parsed.data);
  };
}
```

Fully typed body inside the handler, no validation code in the route, no casts.

### Process level

`unhandledRejection` and `uncaughtException` **log and exit**. A facilitator in
an unknown state is worse than a dead one; once the ledger exists, the intent
row survives the crash and a reconciler finishes the job. Staying alive is how
you get a second broadcast.

---

## D5 — Structure: split on lifecycle, not on line count

### Evidence

No real x402 facilitator examined uses controllers/services/repositories.
They split along a different axis — **by payment scheme and network**:

- `Emmo00/x402go-facilitator` (Hydra): `src/schemes/exact/evm/…`
- `daydreamsai/facilitator`: routes feed a "Payment Scheme Registry"
  (Exact EVM, Upto EVM, Exact SVM)
- `rawgroundbeef/OpenFacilitator`: core package + SDK package

The projects that DID grow modules grew them when a concern acquired its own
**lifecycle or dependency**, not when a file got long:

- BofAI added persistence → storage layer + `/payments` query endpoints
- OpenFacilitator added multi-tenancy → core/SDK split, SQLite schema
- SBC added idempotent settle → machinery to remember prior settlements

Caveat: no line count for any of these main files could be verified.

### Rule

**Split when a concern gains its own lifecycle or dependency. Never at a line
count.** This is defensible on camera; "we used a standard structure" is not.

### Target

facilitator/
app.ts createApp(deps) — wiring, returns the app, never listens
server.ts entrypoint: loadConfig(), build deps, app.listen()
routes.ts the three routes
policy.ts (exists)
wire.ts (exists)
ledger.ts all SQL ← arrives with the ledger
reconciler.ts own loop and timer ← arrives with the ledger


`createApp(deps)` is the load-bearing change, and it is **a seam, not a
layer**. Today `server.ts` constructs its signer, RPC and facilitator at
module scope and calls `listen()` on import, which is why not one route test
exists. A factory taking dependencies as an argument is what makes supertest
possible — the worst gap in the project (59 unit tests, zero covering the code
that moves money).

`agent/` and `merchant/` get the same `createApp` treatment and nothing else.
The merchant has one route returning a stub; splitting it further produces
files containing one function each. The agent is a script with no routes at
all — there is nothing to control, so no controller.

### Rejected

Four-layer routes/controllers/services/repositories. No comparable project
does it, and for a service with three routes it produces mostly-empty files
plus an import graph to navigate them.

---

## D6 — `unknown` at the boundary only; zod replaces hand-written narrowing

### The contradiction in the review, resolved

Comment #32 says "no `unknown` or `any` without justification". Comment #33
says `wire.ts` is over-engineered. But `wire.ts` is *entirely* the machinery
for eliminating `unknown` — that is its only job. Express hands over
`req.body: any`; something must turn it into a typed value. Delete the
narrowing and you are back to casting.

So "over-engineered" cannot mean "checks too much". It means **hand-written
where a declaration would do**:

```ts
// 190 lines of this
function atomicAmount(v: unknown, field: string): string {
  const s = str(v, field);
  if (!/^\d+$/.test(s)) throw new WireError(`${field} must be a decimal integer string…`);
  return s;
}

// vs. one line, per D3
amount: z.string().regex(/^\d+$/, "must be a decimal integer string")
```

D3 already chose zod, so D3 resolves #33. `wire.ts` goes from ~190 lines to
~60 with **no check weakened**.

### Cut as genuinely over-built (independent of zod)

- **The `path` parameter threaded through every function.** zod emits field
  paths for free.
- **Recursively parsing `accepted`** inside the payload. The facilitator acts
  on `paymentRequirements`, never on `accepted` — defensive work with no
  consumer.
- **`ALLOWED_NETWORKS` as an array with `find`** for a single network. It
  existed only to dodge a cast; `z.literal()` does the same.
- **`attemptId`'s fallback branch** for a missing transaction. A payload
  without one already fails parsing, so the branch is unreachable.

### Where `unknown` is correct

Exactly one place per input: the signature that *receives* untrusted data.
`safeParse(req.body)` takes `unknown` because that is the honest type of bytes
off a socket, and it forces narrowing. `unknown` anywhere past the boundary is
a smell — it means someone deferred the question.

### Must not be lost

**`amount` validation stays strict.** The regex looks fussy; it is what stops
`BigInt()` throwing inside `decide()` and the classifier then reporting a
refused payment for what was actually a malformed request. Eight tests cover
it and they carry over to zod unchanged.

### Accepted cost

zod schemas infer zod's types, not `@x402/core`'s. If the SDK changes
`PaymentRequirements`, a schema still compiles and starts silently dropping a
field. Guard every schema with a `satisfies` assertion so drift fails at
compile time. This is the one piece of ceremony worth keeping.

---

## D7 — `shared/classify.ts`

### C1 — Types move out

`SettlementState`, `Phase`, `RefusalKind`, `PassVerdict` → `src/shared/enums.ts`
as `as const` objects (D1). `classify.ts` keeps functions only.

### C2 — Enforce the verify invariant explicitly

```ts
if (phase === Phase.Verify && sig) {
  throw new Error("invariant: verify never broadcasts, so it cannot carry a signature");
}
```

Branches 1 and 2 require `phase === "settle"`; branch 3 requires a signature.
So a verify outcome can only ever reach branch 4 (`expired`) or 5 (`rejected`)
— `confirmed`, `pending` and `failed` are unreachable by construction. That is
correct but *emergent*: nothing in the code states it. One line makes it
enforced and documented. Throwing is right here — it is a programmer error
(D4 class 4), not a payment outcome.

### C3 — Keep `resolvePending`, wire it with the ledger

It is currently called only by tests. Keeping it with a `@see` comment stating
it is not yet wired; the tests document the intended semantics and rewriting
them later is waste.

### C4 — Unchanged

- Empty-signature normalisation (`sig = signature?.trim() ? signature : undefined`)
  stays **inside** `classify`, not at call sites. `SettleResponse.transaction`
  is a REQUIRED string in `@x402/core`, so a refusal that never broadcast
  arrives as `""`. If one caller forgot to normalise, `""` would be truthy at
  the `if (sig)` check and a payment that never left the building would be
  classified `pending` — permanently, since nothing on-chain can resolve it.
- `resolvePending(signature, onChain: { landed, errored })` keeps the
  caller-supplies-the-lookup shape. It stays pure and testable with no network
  and no mocks. Rejected alternative `resolvePending(signature, rpc)` reads
  better but needs a fake RPC in every test, and the caller already holds the
  RPC and must handle its failure regardless.
- The five branches, their order, and the 16 tests stay.

### Answers recorded (review questions #41–#45)

- **Empty signature comes from three callers**, all meaning "nothing
  broadcast": verify (always — verification is simulation); a policy veto
  (refused before reaching the chain); and the SDK's own refusal (because
  `transaction` is a required string with no way to express absence).
- **`onChain` is supplied by the caller**, deliberately — no RPC call inside
  the function.

---

## D8 — `pending` is currently a state with no exit (defect)

Nothing calls `resolvePending`, so a payment reaching `pending` stays there
forever. In a demo that is a payment stuck with no explanation.

The reconciler lands with the ledger and MUST:

- call `getSignatureStatuses([sig], { searchTransactionHistory: true })`.
  **The flag is mandatory.** Without it a node searches only a recent status
  cache. Real production bug: `dfinity/cksol` PR #239 — their cache held
  "roughly two minutes of history", so finalized transactions came back
  unknown and "a withdrawal was resubmitted and a sweep was dropped, even
  though the transaction had been finalized".
- treat a `null` result as "this node does not know", **never** as "it failed".
- declare "never landed" only when BOTH hold: finalized block height has
  passed `lastValidBlockHeight`, AND a history search still returns null.
  A single node's `null` inside the cache window proves nothing — the node may
  be lagging or forked.
- run both ways: on demand when a key is queried again, and from a background
  sweep. Resolve rows within hours — measured RPC retention with the history
  flag was between ~22 h and ~23 d on one public provider, so the long tail is
  not dependable.

---

## D9 — `attemptId` stays in `facilitator/wire.ts`

It is facilitator-local because **only the facilitator computes it**, and it
is *derived* rather than supplied because nobody can supply it.

`@x402/core`'s only header hook is `createAuthHeaders`, and it is keyed by
request **path** (`verify`, `settle`, `supported`), not by payment. It is
called per HTTP request with no knowledge of which payment it serves, so a
merchant using it would produce one id for `/verify` and a different one for
`/settle` — exactly the link we wanted, and the one thing it cannot give.

Both endpoints receive the same signed transaction bytes, so both hash them
and arrive at the same id independently, with nothing transmitted. Keep the
comment explaining this, so a future reader does not "fix" it by making it
merchant-supplied.

**Scope:** one transaction. A retry after expiry is a different transaction
and gets a different id. That is correct, and it is also why D10 exists.

---

## D10 — Adopt the x402 `payment-identifier` extension — IN SCOPE for 2 Nov

### Why

The double-payment hole: agent pays → it settles → the response is lost →
the blockhash expires → the agent builds a **new** transaction and pays again.
Two payments, two signatures, two `attemptId`s, nothing linking them.
`attemptId` cannot catch this by construction, and neither can
`PendingSettlementStore` — its key is derived from the payload, so it changes
when the agent re-signs.

### The mechanism (x402 protocol, docs.x402.org/extensions/payment-identifier)

- The **client** generates one id per *logical purchase*: `pay_<32 hex>`,
  16–128 chars, `^[a-zA-Z0-9_-]+$`. It persists across retries, so it survives
  a fresh 402 and a re-signed transaction.
- Carried in `PaymentPayload.extensions["payment-identifier"]`.
- The **server** advertises it in `PaymentRequired.extensions` with
  `required: true`; missing → 400.
- The server binds the id to a **fingerprint** of scheme, network, asset,
  amount, payTo, resource path and method.
  - same id + same fingerprint → replay the stored answer, skip payment
  - same id + different fingerprint → **409 Conflict**
- TTL ≥ 24 h.

### Two ids, two jobs — do not conflate

| | `attemptId` | `payment-identifier` |
|---|---|---|
| Identifies | one transaction | one logical purchase |
| Origin | facilitator, derived | client, generated once |
| Survives a re-sign | no | **yes** |
| Used for | log correlation | **ledger idempotency** |

### Rejected key candidates, with their failure modes

- **resource URL** — blocks every legitimate second purchase within the TTL
- **payer + resource** — same problem (an agent polling an endpoint twice)
- **memo nonce** — changes per challenge, so it cannot span a re-sign
- **transaction signature / message hash** — changes on re-sign, and is
  *public* once broadcast. x402 PR #3021 removed a "settled nonce → report
  success" path for exactly this: "a settled payload is public… that path
  handed a scraped replay a second resource release"

### Split of responsibility

- **Agent:** generate once per purchase, reuse across retries.
- **Merchant:** advertise `required: true`; replay the stored *resource
  response* on a matching id. Only the merchant can do this — the facilitator
  never sees the body being paid for.
- **Facilitator:** enforce one settlement per (scope, payer, payment_id) +
  fingerprint, in the ledger.

Keep a separate uniqueness constraint on the transaction message hash, so the
same signed bytes can never settle twice.

### Cost, recorded honestly

Touches all three roles and needs the ledger underneath it. 2 Nov now carries:
D1–D8 refactor + ledger + reconciler + payment-identifier. **If time runs
short, drop in this order:** (1) the reconciler's background sweep, keeping
on-demand resolution; (2) merchant-side response replay, keeping
facilitator-side settlement dedup.

Note: Coinbase's x402 FAQ says the extension works with the CDP facilitator
but the CDP SDK does not enable it by default — it is negotiated between
client and server. Stipend controls both, so it can require it.

---

## D11 — `facilitator/policy.ts`

### Keep: `config` as a parameter

Not a module constant. This is what makes the policy testable at different
caps without touching globals, and it is where the Postgres-backed per-agent
limits will plug in. A config object with one field looks silly today and is
the right shape for what is coming.

### Remove: the default parameter value

```ts
// before
decide(amount: bigint, config: PolicyConfig = DEFAULT_POLICY)
// after
decide(amount: AtomicAmount, config: PolicyConfig)
```

A caller who forgets to pass config currently gets a 0.01 USDC cap silently —
a spend limit chosen by a default parameter. D3 rejected exactly this for
`DATABASE_URL`: the quiet path must not be the dangerous one.

It also hides a wiring bug. After D3/D5, config flows from `loadConfig()`
through `createApp(deps)`. Forget to thread it and there is no error — the
facilitator enforces a cap nobody configured, discovered when a legitimate
payment is refused citing an unfamiliar number.

`DEFAULT_POLICY` survives as the value `loadConfig()` falls back to when the
env var is absent. One explicit place instead of every call site.

### Add: a branded type for atomic amounts

`10_000n` is 0.01 USDC **only because USDC has 6 decimals**. Nothing in
`policy.ts` knows that and nothing checks it. Set the cap thinking in dollars
and the limit is a million times too large, with no error anywhere.

```ts
declare const AtomicBrand: unique symbol;
export type AtomicAmount = bigint & { readonly [AtomicBrand]: true };

/** The ONLY way to produce an AtomicAmount. Decimals must be stated. */
export function toAtomic(value: bigint, decimals: number): AtomicAmount;
```

A raw `bigint` can no longer be passed where atomic units are expected. The
mistake becomes a compile error instead of a production surprise — invisible
in review, obvious at runtime, which is the worst combination.

Applies wherever an amount crosses a boundary: `wire.ts` output, the policy
cap from config, the ledger column.

### Unchanged

`decide` stays a pure function over a parsed amount — no network, no request
object. Five tests, no mocks, including the cap-boundary case where an
off-by-one would silently turn the cap into cap-minus-one.

---

## D12 — `facilitator/server.ts`

### 1. Document the signer asymmetry (answers #19)

The agent and facilitator build signers differently **on purpose** — they sign
different parts of the same transaction.

- `toClientSvmSigner(agent)` takes **no RPC**. The agent signs its own slot and
  hands the bytes away: never broadcasts, never reads the chain. That is what
  lets a wallet with zero SOL participate at all.
- `toFacilitatorSvmSigner(feePayer, { defaultRpcUrl })` needs an RPC because it
  fills the fee-payer slot *and* must send and observe. Required:
  `getAddresses()`, `signTransaction()`. Optional:
  `simulateTransactionWithInnerInstructions`,
  `getConfirmedTransactionInnerInstructions`, `getTokenAccountBalance`,
  `fetchAddressLookupTables` — exactly what smart-wallet verification needs.

The asymmetry encodes the trust boundary: one side can only sign, the other can
sign and observe. Add a comment; a reader will otherwise read it as sloppiness.

### 2. Cumulative spend per window — THE FEATURE, not a nice-to-have

`decide()` currently checks a per-payment cap only. **A per-payment cap is not
a spend limit.** An agent capped at 0.01 USDC per payment can spend unlimited
money by paying a thousand times. For a project whose pitch is spend-limited
agent wallets, this is the thinnest part of the build.

Required: cumulative spend per payer per window, backed by the ledger (you
cannot total spend without a record of spend). Lands with the ledger work.
Also belongs in `decide()` eventually: per-payer limits, a blocklist, and
"has this payment-identifier already settled" once D10 exists.

### 3. Inline `reply()` after D4

It exists only because the returned and thrown paths needed the identical
classify → log → respond sequence. D4 removes the thrown path, leaving one
caller. Scaffolding that stops being needed once the error design is fixed.

### 4. Hooks: observation only, and exactly two more (answers #20, #21, hooks Q)

Clarifying a misreading: `onBeforeSettle` does **not** check that the payload is
correct — correctness was already established at verify. It is where *our* rules
go. "Valid but we decline" is the only thing that belongs there, which is why
`refusalKind` distinguishes `terms` (the payment was wrong) from `policy` (it
was fine and we said no).

More hooks would make this *less* abstracted, not more. A hook inverts control:
you cannot return a value to your own route from inside one, request-scoped
logging is awkward to thread, and `onBeforeSettle`'s only way to refuse is to
**throw** — which is precisely how a policy decision came to be disguised as an
exception (see D4).

Add exactly two, both **write-only**, because they do the one thing a route
cannot — observe a settle the route never sees the end of:

- **`onAfterSettle`** → flip the ledger row to `pending` with the signature.
  Fires inside the SDK's flow, so it catches settles the route did not initiate.
- **`onSettleFailure`** → record "we may have broadcast" before anything
  propagates.

The three verify-side hooks buy nothing: verify is synchronous and returns to
the route already.

**Rule: decisions in the route, observation in hooks.**

### 5. Answer recorded — the KNOWN LIMIT comment (#27)

At verify there is never a signature, so `classify` cannot use its primary
signal and falls back to arithmetic: chain height vs. the 402's
`lastValidBlockHeight`. Past it → nothing was broadcast, `expired`, safe to
re-sign. Inside it → refused on the merits, `rejected`.

Arithmetic rather than error text because expiry, a malformed transaction and
a replay all arrive under the SAME `invalidReason`
(`invalid_exact_svm_transaction_simulation_failed`); only the free-text message
differs. Two numbers are a fact; a message is a format that changes in a
release.

The limit, plainly: on a replay the chain is still inside the validity window,
so the two numbers say "not expired" and we answer `rejected` — don't retry.
The agent then behaves correctly, because the money really did move and it
really should not retry. But we got the right behaviour for the wrong reason.
The honest answer was "you already paid, here is the receipt"; we said
"refused". We cannot do better today because the facilitator keeps no record
of anything, and the only hint is the word `AlreadyProcessed` inside an error
sentence we have deliberately chosen not to parse. D10's ledger, keyed by
`payment-identifier`, is what turns a safe guess into a true answer.

---

## D13 — `agent/client.ts`

### 1. Explicit retry cap (#11) — defect

Today the client retries once because the code is written as a single `if`,
not because anything limits it. No counter, no cap, no backoff. For a project
whose pitch is spend-limited wallets, an unbounded retry path is the wrong
default even while the current code happens to be bounded.

`maxRetries` comes from config, defaults to **1**, and the count is checked
rather than implied.

### 2. The diagnosis must survive a dead RPC (#16) — defect

`await getBlockHeight()` inside the diagnosis has no failure path. If the RPC
is slow or down, the client crashes **after a payment attempt whose outcome is
unknown** — the worst possible moment.

Wrap it. If the height lookup fails, **do not retry.** Unknown must never mean
resignable; that is the same rule the classifier already enforces for a
signature.

### 3. `"attempt 1"` becomes the loop counter (#10)

Hardcoded only because it was written as a label. With item 1 it becomes the
counter, so the label cannot disagree with reality.

### 4. Key handling for a live deployment (#2)

"Live on devnet" is the dangerous phrase: once anyone else runs the agent,
devnet does not protect you. The facilitator's fee payer spends real SOL you
topped up, and the agent's seed holds real test USDC. Free money is still
money someone can drain.

- **Agent key — not ours to manage.** Stipend's premise is that an *operator*
  funds a wallet and sets a limit. Their key, their machine. The library
  **accepts** a `TransactionSigner`; it never creates one. So
  `loadOrCreateSigner` is not hardened — it moves to `tools/` as demo
  scaffolding and leaves `shared/`. This also closes a real asymmetry: a
  loader that can silently mint new wallets is currently importable by the
  facilitator.
- **Facilitator fee payer — the key that matters.** The only key that spends
  SOL unprompted. For 2 Nov: injected env secret, **no default, no
  file-creation path**, refuse to boot if absent. Documented as "KMS/HSM
  before mainnet". `FacilitatorSvmSigner` only requires `getAddresses()` and
  `signTransaction()`, so a remote signer drops in later without an interface
  change — nothing demands we hold the bytes.
- **Merchant holds no spending key**, only a receiving address. State this; it
  is a property of the design, not an omission.
- **Blast radius:** keep the fee payer topped up on a schedule rather than
  parking a large balance in a hot key.

### 5. `STALL_MS` leaves the agent (#7)

Test harness. Moves to `harness/`, not shipped in the client.

### Answers recorded

- **#3** `registerExactSvmScheme` registers scheme AND network: the `exact`
  scheme for `solana:…`. Offered anything else, the client has no scheme and
  declines.
- **#4** `toClientSvmSigner` adapts a `@solana/kit` signer to the interface
  `@x402/svm` expects. An adapter at a library boundary, not ceremony.
- **#5** `registerPolicy` receives the protocol version (2) and the decoded
  `accepts` array; we ignore both and return the array unchanged. It is an
  observation point, not a filter.
- **#6, #9** The hook fires during selection — after the 402 arrives, before
  signing — so `requirements[0].extra.lastValidBlockHeight` at that moment is
  the deadline of the challenge actually being signed against. It is the first
  of the two numbers the diagnosis compares.
- **#8** `decode` returns `unknown` because it parses arbitrary base64 JSON off
  the wire. Gets a zod schema and a real return type under D6.
- **#12** A payment can fail at five points: policy refuses before signing; the
  402 cannot be satisfied; verify fails; settle fails before broadcast; settle
  fails after broadcast. **Only the last is `pending`.**
- **#14** Two phases, `verify` and `settle`. The inference is whether a
  signature can exist: verify never has one, so expiry is arithmetic; settle
  can, and a signature overrides every other signal.

---

## D14 — `merchant/server.ts`

1. **`createApp(deps)`** per D5, and nothing more. One route returning a stub
   does not justify further splitting.
2. **`price` and `maxTimeoutSeconds` move to merchant config.** `price` is a
   *business decision* sitting in a server file — it changed twice during
   testing, each time an edit-and-restart. The rest of the static values
   (`scheme: "exact"`, `mimeType`, `description`, `payTo` from the signer)
   stay literal: they are facts about what this merchant is, not knobs.
   `maxTimeoutSeconds: 60` becomes a named constant carrying its reasoning —
   it is coupled to Solana's ~60 s blockhash window, and a lower value means
   abandoning payments that could still land.
3. **`/safety-check` gets its real implementation**, scheduled **after** the
   ledger and **before** the demo video. Scope frozen now so it cannot grow:
   mint authority, freeze authority, Token-2022 permanent delegate and
   default-frozen state, holder concentration, metadata mutability —
   classified against published rules, **no opaque score**. Two Stage 1 probes
   already do the hard parts (mint-account byte parsing,
   `getTokenLargestAccounts`).

   Rationale for the ordering: the paid resource is the least novel part of
   the project, but it is what makes the demo legible. "An agent pays for a
   token safety report" is a sentence anyone understands; "an agent pays for a
   stub" is not. It still comes after the ledger, because the ledger is what
   can still go wrong.

---

## D15 — `shared/chain.ts` becomes a factory (answers #48)

`sendAndConfirm()(signed, …)` has two call sites because `sendAndConfirm` is a
function returning a function: the first `()` builds the sender (opening a
websocket on first use), the second sends.

**Why it was lazy:** confirming a transaction means watching for it, and kit
does that over a **websocket** (`createSolanaRpcSubscriptions`), not HTTP.
Building it at module load would open a socket in `balances.ts`,
`client.ts`, the facilitator and every test — when only `provision.ts` ever
sends anything.

**Why that shape is still wrong:** the laziness works around `chain.ts` doing
work at import time, which D3 and D5 removed everywhere else. It is now the
last module that constructs things when you merely look at it.

```ts
export function createChain(config: ChainConfig) {
  const rpc = createSolanaRpc(config.rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(config.wsUrl);
  return { rpc,
           getBlockHeight: () => rpc.getBlockHeight().send(),
           sendAndConfirm: sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions }) };
}
```

One call at the use site. No module-level cache, no `let`, no hidden
first-use side effect. Tests pass a fake chain object instead of stubbing a
module.

Also in this file:
- **`wsUrl` becomes its own config value.** Deriving it by replacing `http`
  with `ws` works on devnet and silently breaks for any provider whose
  websocket is on a different host.
- **No change to commitment levels** — recorded as justification, not a task.
  `provision.ts` correctly uses `"confirmed"`: a supermajority has voted, it
  is irreversible in practice, and it takes a second or two. `"finalized"`
  (31+ blocks on top, ~13 s) buys certainty that creating a token account does
  not need.

  Where the distinction DOES matter, in the D8 reconciler:
  - "release the resource?" → `confirmed`
  - "close the ledger row permanently?" → `finalized`
  - "declare the payment never landed?" → **block height at `finalized`
    commitment**. A lagging or forked node reporting `confirmed` height could
    say the deadline has passed when it has not, marking a live payment
    expired and inviting a second payment.
