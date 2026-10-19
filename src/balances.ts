import { createSolanaRpc, address } from "@solana/kit";
import { loadOrCreateSigner } from "./keys";

const RPC_URL = "https://api.devnet.solana.com";
const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const rpc = createSolanaRpc(RPC_URL);

for (const name of ["agent", "fee-payer", "merchant"]) {
  const signer = await loadOrCreateSigner(name);

  const sol = await rpc.getBalance(signer.address).send();
  const usdc = await rpc
    .getTokenAccountsByOwner(signer.address, { mint: USDC_MINT }, { encoding: "jsonParsed" })
    .send();

  const amount =
    usdc.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? "no USDC account";

  console.log(`${name.padEnd(10)} SOL=${Number(sol.value) / 1e9}  USDC=${amount}`);
}
