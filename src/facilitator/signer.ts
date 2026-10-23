/**
 * Where the fee payer comes from (D13).
 *
 * The only key in Stipend that spends SOL unprompted. A public facilitator
 * is a faucet unless this is controlled, so the loader here is deliberately
 * NOT the demo one: a missing key must be a hard failure, never a silently
 * generated new wallet.
 *
 * `FacilitatorSvmSigner` requires only getAddresses() and signTransaction(),
 * so a KMS or HSM drops in later without an interface change — nothing
 * demands we hold the bytes. Documented as KMS-before-mainnet.
 */
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

/**
 * Reads FEE_PAYER_SEED (a JSON array of 32 bytes) if set, otherwise the file
 * at FEE_PAYER_KEY_FILE, defaulting to the demo path.
 *
 * No create-if-missing branch. Refusing to start beats starting with a
 * wallet nobody funded.
 */
export async function loadFeePayer() {
  const inline = process.env["FEE_PAYER_SEED"];
  const path = process.env["FEE_PAYER_KEY_FILE"] ?? ".keys/fee-payer.json";

  let raw: string;
  try {
    raw = inline ?? readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no fee payer key: set FEE_PAYER_SEED, or create ${path} with "pnpm exec tsx src/tools/keygen.ts"`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 32) {
    throw new Error("fee payer key must be a 32-element JSON array of bytes");
  }
  return createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(parsed as number[]));
}
