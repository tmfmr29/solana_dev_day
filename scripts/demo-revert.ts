// Live demo: try to send tNVDA to a wallet that is NOT whitelisted and watch the
// network reject it at the protocol level. Then whitelist it and watch it succeed.
// Usage: npx ts-node --transpile-only scripts/demo-revert.ts [RECIPIENT_WALLET]
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { setup, loadConfig, TNVDA_DECIMALS, explorerTx, mask } from "./lib";
import { setKyc } from "./kyc";

async function main() {
  const { admin, connection, provider, program } = setup();
  const cfg = loadConfig();
  const mint = new PublicKey(cfg.tnvdaMint);

  const recipient = process.argv[2] ? new PublicKey(process.argv[2]) : Keypair.generate().publicKey;
  console.log(`Recipient wallet: ${recipient.toBase58()}  (${process.argv[2] ? "provided" : "freshly generated, no KYC profile"})`);

  const fromAta = getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const toAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);

  // Make sure the recipient has a token account (treasury pays).
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, toAta, recipient, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  ));

  const amount = 1n * 10n ** BigInt(TNVDA_DECIMALS);
  const buildTransfer = async () => new Transaction().add(
    await createTransferCheckedWithTransferHookInstruction(
      connection, fromAta, mint, toAta, admin.publicKey, amount, TNVDA_DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID
    )
  );

  console.log(`\n=== Attempt 1: transfer 1 tNVDA to ${mask(recipient)} (NOT whitelisted) ===`);
  try {
    const tx = await buildTransfer();
    const sig = await provider.sendAndConfirm(tx);
    console.log(`UNEXPECTED: transfer went through: ${explorerTx(sig)}`);
  } catch (err: any) {
    const logs: string[] = err.logs ?? err.transactionLogs ?? [];
    const reason = logs.find((l) => l.includes("Error Code") || l.includes("AccountNotInitialized")) ?? err.message;
    console.log(`REVERTED by the Solana runtime.`);
    console.log(`Reason: ${reason.trim()}`);
  }

  console.log(`\n=== Whitelisting ${mask(recipient)} (US person, not sanctioned, KYC cleared) ===`);
  const kycSig = await setKyc(program, admin.publicKey, recipient, true, false, true);
  console.log(explorerTx(kycSig));

  console.log(`\n=== Attempt 2: same transfer, now whitelisted ===`);
  const tx2 = await buildTransfer();
  const sig2 = await provider.sendAndConfirm(tx2);
  console.log(`SUCCESS: ${explorerTx(sig2)}`);
  const bal = await connection.getTokenAccountBalance(toAta);
  console.log(`Recipient tNVDA balance: ${bal.value.uiAmountString}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
