// Terminal version of the compliant swap, using a local "buyer" keypair instead of a
// browser wallet. Same atomic transaction the dashboard builds.
// Usage: npx ts-node --transpile-only scripts/demo-swap.ts <USDC_AMOUNT>
//   First run creates devnet/buyer.json and prints the address; fund it with
//   devnet SOL (faucet.solana.com) and devnet USDC (faucet.circle.com), then rerun.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { setup, loadConfig, loadKeypair, saveKeypair, profilePda, configPda, TNVDA_DECIMALS, explorerTx, mask } from "./lib";

const BUYER_PATH = path.join(__dirname, "..", "devnet", "buyer.json");

async function main() {
  const usdcAmount = Number(process.argv[2] ?? "100");
  const { admin, connection, program } = setup();
  const cfg = loadConfig();
  const TNVDA = new PublicKey(cfg.tnvdaMint), USDC = new PublicKey(cfg.usdcMint), USDC_PROGRAM = new PublicKey(cfg.usdcTokenProgram);

  let buyer: Keypair;
  if (fs.existsSync(BUYER_PATH)) buyer = loadKeypair(BUYER_PATH);
  else { buyer = Keypair.generate(); saveKeypair(BUYER_PATH, buyer); }
  console.log(`Buyer wallet: ${buyer.publicKey.toBase58()}`);

  const sol = await connection.getBalance(buyer.publicKey);
  const buyerUsdc = getAssociatedTokenAddressSync(USDC, buyer.publicKey, false, USDC_PROGRAM);
  const usdcBal = await connection.getTokenAccountBalance(buyerUsdc).then((r) => Number(r.value.uiAmount)).catch(() => 0);
  console.log(`Buyer devnet SOL: ${sol / 1e9}   USDC: ${usdcBal}`);
  if (sol < 0.01e9 || usdcBal < usdcAmount) {
    console.log(`\nFund the buyer first:\n  SOL:  https://faucet.solana.com\n  USDC: https://faucet.circle.com (Solana Devnet)\nthen rerun this script.`);
    return;
  }

  const profile = await (program.account as any).complianceProfile.fetchNullable(
    PublicKey.findProgramAddressSync([Buffer.from("compliance"), buyer.publicKey.toBuffer()], program.programId)[0]);
  console.log(`Compliance profile: ${profile ? `us=${profile.isUsPerson} sanctioned=${profile.isOfacSanctioned} cleared=${profile.kycCleared}` : "NONE (not whitelisted)"}`);

  const usdcBase = BigInt(Math.round(usdcAmount * 1e6));
  const tnvdaBase = usdcBase / BigInt(cfg.priceUsdcPerTnvda);
  const buyerTnvda = getAssociatedTokenAddressSync(TNVDA, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, buyerTnvda, buyer.publicKey, TNVDA, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(buyerUsdc, USDC, new PublicKey(cfg.treasuryUsdcAta), buyer.publicKey, usdcBase, 6, [], USDC_PROGRAM),
    hookTransfer(),
  );
  function hookTransfer() {
    const ix = createTransferCheckedInstruction(new PublicKey(cfg.treasuryTnvdaAta), TNVDA, buyerTnvda, admin.publicKey, tnvdaBase, TNVDA_DECIMALS, [], TOKEN_2022_PROGRAM_ID);
    const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    ix.keys.push(ro(profilePda(program.programId, admin.publicKey)), ro(profilePda(program.programId, buyer.publicKey)), ro(configPda(program.programId)), ro(program.programId), ro(new PublicKey(cfg.extraAccountMetaList)));
    return ix;
  }
  tx.feePayer = buyer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(buyer, admin);

  console.log(`\nSwapping ${usdcAmount} USDC → ${Number(tnvdaBase) / 1e6} tNVDA for ${mask(buyer.publicKey)} in ONE transaction…`);
  try {
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`SUCCESS: ${explorerTx(sig)}`);
  } catch (err: any) {
    const logs: string[] = err.logs ?? err.transactionLogs ?? [];
    console.log(`REVERTED by the network: ${logs.find((l) => l.includes("Error Code")) ?? err.message}`);
    console.log(`(whitelist with: npx ts-node --transpile-only scripts/kyc.ts ${buyer.publicKey.toBase58()})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
