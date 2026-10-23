/**
 * Every chain read in Stipend goes through here.
 *
 * A factory, not a module with top-level state (D15). Nothing is constructed
 * when you merely import this file, so tests pass a fake `Chain` object
 * instead of stubbing a module — and no process opens a websocket it never
 * uses.
 */
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  type Address,
} from "@solana/kit";
import { USDC_MINT_ADDRESS } from "./chain-constants";

export type ChainConfig = {
  rpcUrl: string;
  /**
   * Its own value, not derived from rpcUrl. Replacing "http" with "ws" works
   * on devnet and silently breaks for any provider whose websocket is on a
   * different host.
   */
  wsUrl: string;
};

export type Chain = ReturnType<typeof createChain>;

export function createChain(config: ChainConfig) {
  const rpc = createSolanaRpc(config.rpcUrl);
  const usdcMint = address(USDC_MINT_ADDRESS);

  return {
    rpc,
    usdcMint,

    /**
     * The number the whole expiry story turns on: compare it to the 402's
     * lastValidBlockHeight and you know whether a payment can still land,
     * without reading a single error message.
     */
    getBlockHeight: (): Promise<bigint> => rpc.getBlockHeight().send(),

    solLamports: async (owner: Address): Promise<bigint> =>
      (await rpc.getBalance(owner).send()).value,

    /**
     * `exists` is not cosmetic. On Solana a token balance lives in a separate
     * account per (owner, mint); a wallet that never held the token has no
     * account at all. Absent and zero are different states, and the absent
     * one makes TransferChecked fail with InvalidAccountData.
     */
    usdcBalance: async (owner: Address): Promise<{ exists: boolean; atomic: bigint }> => {
      const r = await rpc
        .getTokenAccountsByOwner(owner, { mint: usdcMint }, { encoding: "jsonParsed" })
        .send();
      const raw = r.value[0]?.account.data.parsed.info.tokenAmount.amount;
      return raw === undefined
        ? { exists: false, atomic: 0n }
        : { exists: true, atomic: BigInt(raw) };
    },

    sendAndConfirm: sendAndConfirmTransactionFactory({
      rpc,
      rpcSubscriptions: createSolanaRpcSubscriptions(config.wsUrl),
    }),
  };
}
