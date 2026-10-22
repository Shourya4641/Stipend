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
