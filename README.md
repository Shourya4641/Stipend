# Stipend

**Spend-limited agent wallets with failure-safe x402 settlement, on Solana.**

Encode Solana Hackathon 2026 — Best Use of x402

🔗 **Live demo:** https://demo-production-1f9e.up.railway.app
Click one button. No wallet, no faucet, no CLI.

---

## The problem

x402 lets an AI agent pay for an HTTP resource with a stablecoin transfer.
Nearly every demo of it shows the happy path: the agent pays, the server
returns 200, everyone claps.

Payments fail. A Solana blockhash expires after about sixty seconds. An RPC
times out after the transaction was already broadcast. A facilitator
crashes between sending bytes and seeing a confirmation. In each case the
agent is left with one question, and it is the only one that matters:

> **Did my money move, and is it safe to pay again?**

Answer it wrong in the safe direction and the agent abandons work it paid
for. Wrong in the dangerous direction and it pays twice.

Stipend is an x402 facilitator built around that question.

## Try it

Open the [live demo](https://demo-production-1f9e.up.railway.app) and press
**Pay**. A hosted agent holding USDC and **zero SOL** pays 0.001 USDC for an
on-chain token safety check. The facilitator covers the transaction fee.

Then press it three more times. The spend window fills, the button
disables, and the page tells you when budget returns. That is the feature
working, not a failure.

## What it does

### Classifies every outcome into a state that answers the question

Not an error string — five states with two booleans:

| State | Meaning | `resignable` | `retryableLater` |
|---|---|---|---|
| `rejected` | Never submitted. Policy or verification said no. | no | if policy |
| `expired` | Blockhash aged out before submission. Nothing reached the chain. | **yes** | — |
| `pending` | Submitted. Outcome unknown. | **never** | — |
| `confirmed` | Landed and succeeded. | no | — |
| `failed` | Landed and the transaction errored. | no | — |

The distinction between `expired` and `pending` is the whole product.
Expired means the transaction is permanently dead, so a fresh payment is
one payment. Pending means the bytes may have landed, and re-signing pays
twice. The two are never collapsed, and **a signature always forbids
re-signing** — enforced by a brute-force test over every combination of
inputs.

Expiry is decided by **block height arithmetic, not by error messages**. A
stalled agent works out for itself that its payment is dead, then pays once
more. Verified end to end on devnet: 402, diagnosis, 200, and exactly one
payment's worth of USDC spent across two attempts.

### Records intent before broadcasting, not after

The gap between sending bytes to the chain and receiving a response is
where money goes missing. Crash there with no row and a payment may have
landed with nothing recording it.

no row -> we definitely did not broadcast
row, unresolved -> we might have. Ask the chain; never re-sign.


The row is keyed on a **hash of the transaction message** — everything
except signatures — which is fixed the moment the agent builds the
transaction. The transaction id cannot serve: it *is* the fee payer's
signature, produced inside `settle()` at the same moment it broadcasts.
Hashing the message also means nobody can mint a fresh identity for the
same payment by mutating a signature byte.

If the ledger write fails, the facilitator returns **502 and broadcasts
nothing**. Settling with no record is the failure the table exists to
prevent, so the service is deliberately less available than it could be.
Verified by killing Postgres mid-flight and confirming the agent's balance
did not move.

### Bounds what an agent can lose

A per-payment cap refuses one oversized payment. **A cumulative cap across
a rolling window is the actual spend limit** — an agent capped at 0.001
USDC per payment can still spend without bound by paying a thousand times.

Pending payments count against the window, deliberately: a payment that
*might* have landed must not be free. The consequence is that reconciling
pending rows is what *releases* budget, not merely bookkeeping.

The payer is read from the transaction's signature map, never from the
request — a self-declared payer could name someone else's address and spend
their budget.

### Lets a wallet with zero SOL pay

The agent holds USDC and no SOL. The facilitator occupies the fee-payer
slot and signs for that slot alone; it never touches the agent's money.
That is what makes "fund an agent with stablecoins and nothing else" work.

### The paid resource is real

`GET /safety-check?mint=…` returns six on-chain facts about a token: mint
authority, freeze authority, token program, Token-2022 extensions, supply,
and holder concentration. Each finding names **what was read** and **which
rule applies**.

No score. A number like 87/100 hides the rule that produced it and cannot
be argued with. The verdict is the **worst finding, not an average** —
devnet USDC returns two risks alongside four clean facts and is correctly
`risk`.

A fact the chain will not give us is reported as `unavailable` with its
reason, never omitted and never assumed safe.

---

## Architecture

agent/ Holds USDC and zero SOL. Signs its own slot and hands the
bytes away. Diagnoses its own failures with the same
classifier the facilitator runs.

merchant/ Returns 402 with payment terms, serves the safety check.
Holds an address, never a key it can spend with.

facilitator/ Verifies, enforces both caps, occupies the fee-payer slot,
broadcasts, records. The only service with a key that
spends SOL.

demo/ A hosted agent with a web face. A browser cannot pay, so
the button triggers an agent server-side.

shared/ The classifier, the enums, the chain factory, branded
amounts. Cross-role vocabulary only.


Roles cannot import each other — enforced by a test that parses import
statements, not by convention. `demo/` may import `agent/` because it is
one; nothing may import `demo/`, so "the demo works" keeps implying "the
system works".

### Design decisions worth naming

**Answers are returns; accidents are exceptions.** A payment outcome never
travels as an exception, because `catch` receives an `Error` with a string
in it and every structured field is gone. A policy veto is a branch.
Infrastructure failure is a throw, and becomes a 502 — the status says
which end broke.

**Amounts are branded.** `10_000n` is 0.01 USDC only because USDC has six
decimals, and nothing checked that. `toAtomic(value, decimals)` is the only
constructor, so every call site states its units and a bare number cannot
reach a money decision.

**The database and the code cannot drift.** Settlement states are declared
once in TypeScript; the Postgres CHECK constraint is generated from the
same array.

**Nothing happens at import time.** Every role is a `createApp(deps)`
factory and config is parsed when asked for. That is what makes route tests
possible at all.

---

## Tests

**185 tests, about six seconds.**

- **Route tests** drive the facilitator with a stubbed SDK and a fake
  chain, covering outcomes devnet will not produce on demand: a settle that
  throws, success with no signature, a broadcast failure that looks like
  expiry, a malformed body mid-flow.
- **Ledger tests** run against **PGlite** — Postgres compiled to
  WebAssembly, in-process — applying the project's **real migrations**, so
  the actual constraints and the actual trigger are exercised.
- **Devnet harnesses**, separate and manual: expiry, replay, and
  stall-and-recover.
- **Boundary tests** fail if a role crosses into another role's folder.

Several real bugs were caught by tests asserting on *what a route did*
rather than what it returned — including a policy veto that replied and
then fell through to broadcast the payment anyway.

---

## Running it locally

```bash
pnpm install
docker compose up -d                       # Postgres 18
cp .env.example .env                       # set MERCHANT_PAY_TO
pnpm exec tsx src/tools/keygen.ts
pnpm db:migrate
```

Fund the agent with devnet USDC (Circle faucet) and the fee payer with
devnet SOL, then:

```bash
pnpm exec tsx src/facilitator/server.ts    # :3000
pnpm exec tsx src/merchant/server.ts       # :4021
pnpm exec tsx src/demo/server.ts           # :4040  <- open this
pnpm exec tsx src/agent/client.ts          # or pay from the CLI
```

```bash
pnpm test
pnpm exec tsx src/harness/agent-recovery-devnet.ts   # stall, expire, recover
```

A public RPC will rate-limit the safety check — it makes three calls per
request. Use an Alchemy or Helius devnet endpoint.

---

## Known limitations

Stated here rather than discovered by a judge.

- **`pending` has no exit.** No reconciler sweeps unresolved rows to ask
  the chain what happened. Because pending payments count against the spend
  window, this means budget is released only as rows age out of the window
  rather than when their outcome is learned. The classifier's
  `resolvePending()` is written and tested; nothing calls it on a timer.
- **No `payment-identifier`.** The x402 extension that links retries of one
  logical purchase across different signed transactions. The ledger schema
  has the column and the partial unique index; the roles do not exchange
  the header. Consequence: `AlreadyProcessed` is classified `rejected` —
  the *safe* answer (do not retry) but not the *true* one, which is that
  the money already moved and the honest reply is a receipt.
- **No atomic yield redemption.** The original pitch included redeeming
  from a lending position inside the payment transaction. It needs a
  mainnet fork and an x402 verification path this project has never
  exercised; it was cut on 4 November rather than half-shipped.
- **The window check is not atomic.** Two payments arriving together can
  read the same spent total and both pass, exceeding the cap by at most one
  payment — which the per-payment cap bounds. Closing it needs the read and
  the insert in one transaction with the payer's rows locked.
- **A bad mint is rejected after payment.** The merchant validates the mint
  after settlement, so a typo costs 0.001 USDC. Validating before the 402
  costs an RPC call on every unpaid request, which is a denial-of-service
  vector without rate limiting on that path.
- **A public facilitator is a faucet.** It pays fees for whoever asks. The
  spend caps bound the loss and there is per-IP rate limiting, but an API
  key is needed before this is anything but a devnet demo.
- **Devnet only.** Mainnet needs a KMS-backed fee payer; the signer
  interface already allows one with no code change.

## Prior art, and what is actually new

`@x402/core` ships a `PendingSettlementStore` interface, so tracking
pending settlements is not a Stipend invention. What it ships is an
in-process `Map` that dies on restart and cannot be shared between
replicas.

What this adds: a durable implementation behind that idea, a classifier
that refuses to confuse *expired* with *pending* and proves a signature
always forbids re-signing, intent recorded before the broadcast rather
than after, and spend limits that bound an agent's total exposure rather
than one transaction's size.
