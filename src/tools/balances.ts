import { loadOrCreateSigner } from "../shared/keys";
import { createChain } from "../shared/chain";
import { loadConfig } from "./config";

const chain = createChain(loadConfig().chain);

for (const name of ["agent", "fee-payer", "merchant"]) {
  const signer = await loadOrCreateSigner(name);

  const sol = await chain.solLamports(signer.address);
  const usdc = await chain.usdcBalance(signer.address);

  // "no USDC account" and "0" are different on-chain states, not a display
  // nicety: the absent one makes TransferChecked fail with InvalidAccountData.
  const shown = usdc.exists
    ? (Number(usdc.atomic) / 1e6).toString()
    : "no USDC account";

  console.log(`${name.padEnd(10)} SOL=${Number(sol) / 1e9}  USDC=${shown}`);
}
