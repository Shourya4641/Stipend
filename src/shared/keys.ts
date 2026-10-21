import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { CONSTANTS } from "./constants";

/**
 * Load a signer from .keys/, creating it on first use.
 * Stored form is the 32-byte Ed25519 SEED as a JSON number array.
 */
export async function loadOrCreateSigner(name: string) {
  mkdirSync(CONSTANTS.KEY_DIR, { recursive: true, mode: 0o700 });
  const path = `${CONSTANTS.KEY_DIR}/${name}.json`;

  let seed: Uint8Array;

  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length !== 32) {
      throw new Error(
        `${path}: expected a 32-element array, got ${JSON.stringify(raw).slice(0, 40)}`,
      );
    }
    seed = Uint8Array.from(raw as number[]);
  } else {
    seed = new Uint8Array(randomBytes(32));
    writeFileSync(path, JSON.stringify(Array.from(seed)), { mode: 0o600 });
  }

  return createKeyPairSignerFromPrivateKeyBytes(seed);
}
