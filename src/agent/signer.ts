/**
 * Where the agent's key comes from (D13).
 *
 * Not ours to manage. Stipend's premise is that an operator funds a wallet
 * and sets a limit — their key, their machine. This reads one; it never
 * creates one. The demo loader that mints a wallet when the file is absent
 * stays in tools/, where demo scaffolding belongs.
 */
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

export async function loadAgentSigner() {
  const inline = process.env["AGENT_SEED"];
  const path = process.env["AGENT_KEY_FILE"] ?? ".keys/agent.json";

  let raw: string;
  try {
    raw = inline ?? readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no agent key: set AGENT_SEED, or create ${path} with "pnpm exec tsx src/tools/keygen.ts"`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 32) {
    throw new Error("agent key must be a 32-element JSON array of bytes");
  }
  return createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(parsed as number[]));
}
