/**
 * Every chain read in Stipend goes through this module.
 *
 * Not a service: a module. A separate process would add a hop, a dependency
 * and a trust boundary without removing any — and for the agent's expiry
 * check it would actively hurt, because the whole point is that the agent
 * decides for itself rather than trusting someone's report of the height.
 *
 * What this does buy: one RPC endpoint, one place to add a fallback or
 * retries, one thing to stub in tests.
 */
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  type Address,
} from "@solana/kit";
import { CONSTANTS } from "./config/constants";

export const USDC_MINT = address(CONSTANTS.USDC_MINT);

export const rpc = createSolanaRpc(CONSTANTS.RPC_URL);

/**
 * Current block height.
 *
 * The number the whole expiry story turns on: compare it to the 402's
 * lastValidBlockHeight and you know whether a payment can still land,
 * without reading a single error message.
 */
export async function getBlockHeight(): Promise<bigint> {
  return rpc.getBlockHeight().send();
}

export async function solLamports(owner: Address): Promise<bigint> {
  const r = await rpc.getBalance(owner).send();
  return r.value;
}

/**
 * USDC held by an owner, in atomic units.
 *
 * `exists` is not cosmetic. On Solana a token balance lives in a separate
 * account per (owner, mint); a wallet that never held the token has no
 * account at all. Absent and zero are different states, and the absent one
 * makes TransferChecked fail with InvalidAccountData.
 */
export async function usdcBalance(
  owner: Address,
): Promise<{ exists: boolean; atomic: bigint }> {
  const r = await rpc
    .getTokenAccountsByOwner(owner, { mint: USDC_MINT }, { encoding: "jsonParsed" })
    .send();
  const raw = r.value[0]?.account.data.parsed.info.tokenAmount.amount;
  return raw === undefined
    ? { exists: false, atomic: 0n }
    : { exists: true, atomic: BigInt(raw) };
}

/**
 * Lazily built, because creating the subscriptions transport opens a
 * websocket. Only provision.ts sends transactions; the agent, merchant and
 * tests should not hold a socket they never use.
 */
let cached: ReturnType<typeof sendAndConfirmTransactionFactory> | undefined;

export function sendAndConfirm() {
  if (!cached) {
    const rpcSubscriptions = createSolanaRpcSubscriptions(
      CONSTANTS.RPC_URL.replace(/^http/, "ws"),
    );
    cached = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  }
  return cached;
}
