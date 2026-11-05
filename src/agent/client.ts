/**
 * The agent as a CLI. A thin shell over createPayer, so this and the
 * hosted demo run identical code — a demo that reimplements the agent is
 * one that can diverge from what it claims to show.
 *
 *   pnpm exec tsx src/agent/client.ts
 *   MINT=<address> pnpm exec tsx src/agent/client.ts
 */
import { loadAgentSigner } from "./signer";
import { createChain } from "../shared/chain";
import { loadConfig } from "./config";
import { createPayer } from "./pay";

const config = loadConfig();
const chain = createChain(config.chain);
const signer = await loadAgentSigner();

const mint = process.env["MINT"] ?? "So11111111111111111111111111111111111111112";
const url = `${config.merchantUrl}/safety-check?mint=${mint}`;

console.log(`agent ${signer.address} requesting ${url}\n`);

const pay = createPayer({ signer, chain, maxRetries: config.maxRetries });
const result = await pay(url);

for (const a of result.attempts) {
  console.log(`[attempt ${a.attempt}] status ${a.status}`);
  if (a.stipend) console.log(JSON.stringify(a.stipend, null, 2));
  if (a.diagnosis) {
    console.log(
      `[diagnosis] ${a.diagnosis.state} resignable=${a.diagnosis.resignable} — ${a.diagnosis.reason}`,
    );
  }
}

console.log(`\nfinal status ${result.status} after ${result.attempts.length} attempt(s)`);
console.log(JSON.stringify(result.body, null, 2));
