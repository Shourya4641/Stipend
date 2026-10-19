import { loadOrCreateSigner } from "./keys";

const agent = await loadOrCreateSigner("agent");
const feePayer = await loadOrCreateSigner("fee-payer");
const merchant = await loadOrCreateSigner("merchant");

console.log("agent     ", agent.address);
console.log("fee-payer ", feePayer.address);
console.log("merchant  ", merchant.address);
