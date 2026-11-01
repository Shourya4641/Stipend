# Stipend

**Spend-limited agent wallets with failure-safe x402 settlement, on Solana.**

Encode Solana Hackathon 2026 --
Status: checkpoint 2 (1 November 2026). Final submission 9 November 2026.

---

## The problem

x402 lets an AI agent pay for an HTTP resource with a stablecoin transfer.
Nearly every demo of it shows the happy path: the agent pays, the server
returns 200, everyone claps.

Payments fail. A Solana blockhash expires after about sixty seconds. An RPC
times out after the transaction was already broadcast. A facilitator
crashes between sending bytes and seeing a confirmation. In each case the
agent is left with the same question, and it is the only question that
matters:

> **Did my money move, and is it safe to pay again?**

Get that wrong in the safe direction and the agent gives up on work it paid
for. Get it wrong in the dangerous direction and it pays twice.

Stipend is an x402 facilitator built around that question.

## What it does

**Classifies every payment outcome into a state that answers it.** Not an
error string — five states with two booleans:

| State | Meaning | `resignable` | `retryableLater` |
|---|---|---|---|
| `rejected` | Never submitted. Policy or verification said no. | no | if policy |
| `expired` | Blockhash aged out before submission. Nothing signed onto the chain. | **yes** | — |
| `pending` | Submitted. Outcome unknown. | **never** | — |
| `confirmed` | Landed and succeeded. | no | — |
| `failed` | Landed and the transaction errored. | no | — |

The distinction between `expired` and `pending` is the whole product.
Expired means the transaction is permanently dead and a fresh payment is
one payment. Pending means the bytes may have landed, and re-signing pays
twice. The system never collapses them, and a signature **always** forbids
re-signing — enforced by a brute-force test over every combination of
inputs.

**Records intent before broadcasting, not after.** The gap between sending
bytes to the chain and receiving a response is where money goes missing.
Crash there with no row, and a payment may have landed with nothing
recording it. Stipend writes a durable row *first*:

no row -> we definitely did not broadcast
row, unresolved -> we might have. Ask the chain; never re-sign.


This is possible because the facilitator is the fee payer. The row is keyed
on a **hash of the transaction message** — everything except signatures —
which is fixed the moment the agent builds the transaction, unlike the
transaction id, which is the fee payer's signature and only exists after
settlement begins. Hashing the message rather than the payload also means
an attacker cannot mint a fresh identity for the same payment by mutating a
signature byte.

**Lets a wallet with zero SOL pay.** The agent holds USDC and no SOL. The
facilitator occupies the fee-payer slot and signs for that slot alone — it
never touches the agent's money. This is what makes "fund an agent with
stablecoins and nothing else" possible.

**Bounds what an agent can lose.** A per-payment cap refuses one oversized
payment. A cumulative cap across a rolling window is the actual spend
limit. (See *Current state* — the second one is built and tested but not
yet enforced.)

---

## Current state, honestly

### Working end to end on devnet

- **Zero-SOL payment.** Agent with 0 SOL pays a merchant; the facilitator
  covers the fee. Verified on devnet with balances checked before and after.
- **Blockhash expiry and recovery.** A stalled agent diagnoses its own
  expiry from block height arithmetic — not from an error message — and
  pays once more. Asserted end to end: 402, then diagnosis, then 200, with
  exactly one payment's worth of USDC spent across two attempts.
- **Policy veto.** A payment over the per-payment cap is refused before
  anything reaches the chain, with `retryableLater: true` so the agent
  knows the terms may work later.
- **Replay protection.** A second submission of the same transaction is
  refused by the chain's own signature dedup, and by the ledger's unique
  index before that.
- **Durable ledger.** Every settlement writes a row before broadcast and
  resolves after. Verified against a real Postgres: intent, outcome,
  signature, and the signed bytes dropped on resolution.
- **Fail-closed settlement.** If the ledger write fails, the facilitator
  returns 502 and **nothing is broadcast**. Settling with no record is the
  failure the ledger exists to prevent, so the facilitator is deliberately
  less available than it would otherwise be.

### Built and tested, not yet enforced

- **Cumulative spend cap.** `decideWindow()` and `ledger.spentSince()` both
  exist with full test coverage, including a loop proving that twenty
  payments which each pass the per-payment cap are cut off at ten by the
  window cap. **Neither is called from the settle route yet.** Right now the
  facilitator enforces only the per-payment cap. First item after this
  checkpoint.

### Not built

- **Reconciler.** `pending` is currently a state with no exit. Nothing
  sweeps unresolved rows and asks the chain what happened. This matters
  more than it looks: because pending payments count against the spend
  window, the reconciler is what *releases* spending capacity — without it,
  an agent's budget ratchets downward on every failure.
- **`payment-identifier` extension.** The x402 extension that links retries
  of one logical purchase across different signed transactions. The ledger
  schema already has the column and the partial unique index; the three
  roles do not yet exchange the header.
- **Atomic yield redemption.** See *The plan* below.
- **Dashboard, deployment, real `/safety-check`.** The paid resource is
  currently a stub.

### Test suite

146 tests, about six seconds.

- **Route tests** drive the facilitator with a stubbed SDK and a fake
  chain, covering the outcomes devnet will not produce on demand: a settle
  that throws, success with no signature, a broadcast failure that looks
  like expiry, a malformed body arriving mid-flow.
- **Ledger tests** run against **PGlite** — real Postgres compiled to
  WebAssembly, in-process — applying the project's **actual migrations**,
  so the real constraints and the real trigger are exercised rather than a
  hand-written approximation.
- **Devnet harnesses** are separate and manual: expiry, replay, and the
  stall-and-recover scenario.
- **Boundary tests** parse import statements and fail if a role crosses
  into another role's folder, or if product code imports demo scaffolding.

---

## Architecture

agent/ A wallet holding USDC and zero SOL. Signs its own slot and
hands the bytes away. Diagnoses its own failures using the
same classifier the facilitator runs.

merchant/ Returns 402 with payment terms. Holds an address, never a
key it can spend with.

facilitator/ Verifies, enforces policy, occupies the fee-payer slot,
broadcasts, and records. The only service with a key that
spends SOL.

shared/ The classifier, the enums, the chain factory, branded
amounts. Cross-role vocabulary only.


Roles cannot import each other — enforced by a test, not convention.

### Design decisions worth naming

**Answers are returns; accidents are exceptions.** A payment outcome never
travels as an exception, because `catch` receives an `Error` with a string
in it and every structured field is gone. A policy veto is a branch, not a
throw. Infrastructure failure is a throw, and becomes a 502 — the status
says which end broke.

**Amounts are branded.** `10_000n` is 0.01 USDC only because USDC has six
decimals, and nothing checked that. `toAtomic(value, decimals)` is the only
way to construct an amount, so every call site states its units out loud
and a bare number cannot reach a money decision.

**The database and the code cannot drift.** The settlement states are
declared once in TypeScript; the Postgres CHECK constraint is generated
from the same array.

**Nothing happens at import time.** Every role is a `createApp(deps)`
factory. Config is parsed when asked for, not when a module loads. This is
what makes the route tests possible at all.

---

## Running it

```bash
pnpm install
docker compose up -d          # Postgres 18, with a healthcheck
cp .env.example .env          # then set MERCHANT_PAY_TO
pnpm exec tsx src/tools/keygen.ts
pnpm db:migrate
```

Fund the agent with devnet USDC (Circle faucet) and the fee payer with
devnet SOL, then:

```bash
pnpm exec tsx src/facilitator/server.ts    # :3000
pnpm exec tsx src/merchant/server.ts       # :4021
pnpm exec tsx src/agent/client.ts
```

```bash
pnpm test                                       # 146 unit and route tests
pnpm exec tsx src/harness/agent-recovery-devnet.ts   # stall, expire, recover
```

Docker currently supplies only Postgres. The three services join
`compose.yaml` before final submission, so `docker compose up` starts
everything.

---

## The plan to 9 November

| Date | Work |
|---|---|
| 3 Nov | Wire the cumulative cap into `/settle`. Reconciler. |
| 3–4 Nov | `payment-identifier` across all three roles. Deploy to Railway. |
| **4 Nov** | **Yield go/no-go (below).** |
| 5–6 Nov | Yield if go; dashboard and real `/safety-check` if no-go. |
| 7–8 Nov | Dashboard, `/safety-check`, README, demo video. |
| 9 Nov | Submission. |

### The yield go/no-go

The original pitch was *yield-bearing* spend-limited wallets: an agent's
idle USDC sits in a lending position, and the payment transaction redeems
exactly what it needs **atomically**, in the same transaction as the
transfer. Nothing is sold if the payment fails.

This is the most interesting claim in the project and the least certain.
Two unknowns:

1. **Surfpool.** Devnet has no live Jupiter Lend, so this requires a
   mainnet fork — forking, funding a wallet with a real lending position,
   and keeping it alive across a recorded demo. Unattempted.
2. **Whether x402 will accept a composed transaction.** The `exact` SVM
   scheme has a fast path that accepts only three to seven instructions in
   a fixed order; a redeem blows past it. There is a fallback that
   simulates the transaction and extracts the transfer from the CPI trace,
   which *should* mean a transfer emitted inside a Jupiter redeem counts —
   but that is a code path this project has never exercised, and failure
   looks like "verify says no" with little explanation.

**So 4 November is a decision, not a milestone.** One day is spent
answering only "does a composed transaction pass verify on a fork?" If yes,
yield ships. If no, it is cut and named as future work, and those days go to
the dashboard and the real safety-check endpoint.

Shipping a working, live, honestly-described facilitator beats shipping a
broken demo of a more ambitious one.

### What the final submission should look like

A live URL. A merchant serving a real token-safety check as the paid
resource — six on-chain facts, classified against published rules, no
opaque score. A facilitator enforcing both caps, with a reconciler
resolving pending payments. A dashboard where a judge clicks one button,
watches a payment appear in the ledger and resolve, and sees the spend
window tighten — no wallet, no faucet, no CLI. And a video that shows a
payment **failing** and being recovered from, because that is the part
nobody else demonstrates.

---

## Known limitations

- **The cumulative cap is not enforced yet** (above).
- **`pending` has no exit** until the reconciler exists.
- **The window check is not atomic.** Two payments arriving together can
  read the same spent total and both pass, exceeding the cap by at most one
  payment — which the per-payment cap bounds. Closing it needs the read and
  the insert in one transaction with the payer's rows locked.
- **`AlreadyProcessed` is classified as `rejected`.** That is the *safe*
  answer — do not retry — but not the *true* one, which is that the money
  already moved and the honest reply is a receipt. Distinguishing them
  needs `payment-identifier`.
- **A public facilitator is a faucet.** It pays fees for whoever asks. The
  spend caps bound the loss; rate limiting and an API key are needed before
  the URL is public.
- **Replay protection across restarts is the chain's**, not Stipend's. The
  signature dedup window belongs to Solana. Stipend's ledger adds
  idempotency by payment identity, which is a different guarantee.
- **Devnet only.** Mainnet needs a KMS-backed fee payer; the signer
  interface already allows one without a code change.

## Prior art, and what is actually new

`@x402/core` ships a `PendingSettlementStore` interface, so "track pending
settlements" is not a Stipend invention. What core ships is an in-process
`Map`, which loses everything on restart and cannot be shared between
replicas.

What this project adds: a durable implementation behind that idea, a
settlement classifier that distinguishes *expired* from *pending* and
proves a signature always forbids re-signing, intent recorded before
broadcast rather than after, and spend limits that bound an agent's total
exposure rather than one transaction's size.
