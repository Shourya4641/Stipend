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
