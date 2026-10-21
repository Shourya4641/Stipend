# harness

Manual devnet scenarios. **Not run by `pnpm test`.**

They need a funded agent, three running services, and up to 75 seconds of
real block time, so they are scripts you run and read — not assertions a
suite can gate on. Deliberately named `*-devnet.ts` rather than `*.test.ts`
so neither the runner nor a reader mistakes them for unit tests.

```bash
pnpm exec tsx src/harness/expiry-devnet.ts
pnpm exec tsx src/harness/replay-devnet.ts
```
