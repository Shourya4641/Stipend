import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  assertIsTransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { loadOrCreateSigner } from "./keys";
import { rpc, sendAndConfirm, USDC_MINT } from "./chain";

const feePayer = await loadOrCreateSigner("fee-payer");
const merchant = await loadOrCreateSigner("merchant");

// Pure derivation: no network call. A token account's address is a function
// of (owner, mint, token program), so it is knowable before it exists.
const [ata] = await findAssociatedTokenPda({
  owner: merchant.address,
  mint: USDC_MINT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
console.log(`merchant ${merchant.address}`);
console.log(`its USDC account would be ${ata}`);

// payer and owner differ: the fee payer rents the account into existence,
// the merchant owns it. The merchant never needs SOL.
const createIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
  payer: feePayer,
  owner: merchant.address,
  mint: USDC_MINT,
});

const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

// Four things every Solana transaction needs, in order: a version, a fee
// payer, a lifetime, and instructions. pipe() threads the message through
// each step — each returns a new message rather than mutating.
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(feePayer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  (m) => appendTransactionMessageInstruction(createIx, m),
);

const signed = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(signed);

await sendAndConfirm()(signed, { commitment: "confirmed" });
console.log(`confirmed: ${getSignatureFromTransaction(signed)}`);
