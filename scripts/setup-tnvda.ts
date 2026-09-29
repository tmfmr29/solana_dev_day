// One-time devnet setup: create the tNVDA Token-2022 mint with the compliance
// transfer hook attached, initialize the hook's extra-account list, whitelist the
// treasury, and mint the initial supply to it.
// Usage: npx ts-node --transpile-only scripts/setup-tnvda.ts
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  CONFIG_PATH, MINT_KEYPAIR_PATH, TNVDA_DECIMALS, USDC_MINT,
  setup, saveKeypair, loadKeypair, extraMetasPda, configPda, explorerAddr, explorerTx, DevnetConfig, tokenProgramFor,
} from "./lib";
import { setKyc } from "./kyc";

const INITIAL_SUPPLY = 1_000_000n * 10n ** BigInt(TNVDA_DECIMALS); // 1,000,000 tNVDA
const PRICE_USDC_PER_TNVDA = 100; // demo price

async function main() {
  const { admin, connection, provider, program } = setup();
  console.log(`Admin / treasury wallet: ${admin.publicKey.toBase58()}`);
  console.log(`Program:                 ${program.programId.toBase58()}`);

  const bal = await connection.getBalance(admin.publicKey);
  console.log(`Devnet SOL balance:      ${bal / 1e9}`);
  if (bal < 0.2e9) throw new Error("Need devnet SOL. Run: solana airdrop 2 --url devnet");

  const programInfo = await connection.getAccountInfo(program.programId);
  if (!programInfo?.executable) throw new Error("Program is not deployed on devnet yet. Run: anchor deploy --provider.cluster devnet");

  // 0. Program config (admin + trading-halt flag). Created once; the payer becomes admin.
  const cfgPda = configPda(program.programId);
  if (!(await connection.getAccountInfo(cfgPda))) {
    const sig = await program.methods.initializeConfig()
      .accountsPartial({ admin: admin.publicKey, config: cfgPda, systemProgram: SystemProgram.programId }).rpc();
    console.log(`\n[0] Config initialized, admin = ${admin.publicKey.toBase58()}\n    ${explorerTx(sig)}`);
  } else {
    console.log(`\n[0] Config already initialized`);
  }

  // Reuse the mint keypair if this script ran before, so re-running is safe.
  let mint: Keypair;
  if (fs.existsSync(MINT_KEYPAIR_PATH)) {
    mint = loadKeypair(MINT_KEYPAIR_PATH);
    console.log(`Reusing mint keypair     ${mint.publicKey.toBase58()}`);
  } else {
    mint = Keypair.generate();
    saveKeypair(MINT_KEYPAIR_PATH, mint);
  }

  // 1. Create the mint with the TransferHook extension pointing at our program.
  if (!(await connection.getAccountInfo(mint.publicKey))) {
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey,
        space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(mint.publicKey, admin.publicKey, program.programId, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, TNVDA_DECIMALS, admin.publicKey, null, TOKEN_2022_PROGRAM_ID)
    );
    const sig = await provider.sendAndConfirm(tx, [mint]);
    console.log(`\n[1] tNVDA mint created with transfer hook\n    ${explorerTx(sig)}`);
  } else {
    console.log(`\n[1] tNVDA mint already exists`);
  }

  // 2. Initialize the extra-account-meta list (tells Token-2022 to pass the KYC profiles to the hook).
  const metas = extraMetasPda(program.programId, mint.publicKey);
  if (!(await connection.getAccountInfo(metas))) {
    const sig = await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({ admin: admin.publicKey, config: cfgPda, extraAccountMetaList: metas, mint: mint.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`[2] Extra account meta list initialized\n    ${explorerTx(sig)}`);
  } else {
    console.log(`[2] Extra account meta list already initialized`);
  }

  // 3. Whitelist the treasury (it is the source of every transfer, so it must be compliant).
  const sig3 = await setKyc(program, admin.publicKey, admin.publicKey, true, false, true);
  console.log(`[3] Treasury KYC profile set (US person, not sanctioned, cleared)\n    ${explorerTx(sig3)}`);

  // 4. Treasury token accounts (tNVDA on Token-2022, USDC on classic Token program) + mint supply.
  const treasuryTnvda = getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const usdcProgram = await tokenProgramFor(connection, USDC_MINT);
  console.log(`USDC mint ${USDC_MINT.toBase58()} is owned by: ${usdcProgram?.toBase58() ?? "NOT FOUND ON DEVNET"}`);
  const treasuryUsdc = getAssociatedTokenAddressSync(USDC_MINT, admin.publicKey, false, usdcProgram ?? TOKEN_PROGRAM_ID);
  const tx4 = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, treasuryTnvda, admin.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  if (usdcProgram) {
    tx4.add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, treasuryUsdc, admin.publicKey, USDC_MINT, usdcProgram, ASSOCIATED_TOKEN_PROGRAM_ID));
  }
  const existing = await connection.getTokenAccountBalance(treasuryTnvda).catch(() => null);
  if (!existing || existing.value.amount === "0") {
    tx4.add(createMintToInstruction(mint.publicKey, treasuryTnvda, admin.publicKey, INITIAL_SUPPLY, [], TOKEN_2022_PROGRAM_ID));
  }
  const sig4 = await provider.sendAndConfirm(tx4);
  console.log(`[4] Treasury accounts ready, ${INITIAL_SUPPLY / 10n ** BigInt(TNVDA_DECIMALS)} tNVDA minted\n    ${explorerTx(sig4)}`);

  const config: DevnetConfig = {
    programId: program.programId.toBase58(),
    tnvdaMint: mint.publicKey.toBase58(),
    usdcMint: USDC_MINT.toBase58(),
    treasury: admin.publicKey.toBase58(),
    treasuryTnvdaAta: treasuryTnvda.toBase58(),
    treasuryUsdcAta: treasuryUsdc.toBase58(),
    usdcTokenProgram: (usdcProgram ?? TOKEN_PROGRAM_ID).toBase58(),
    extraAccountMetaList: metas.toBase58(),
    priceUsdcPerTnvda: PRICE_USDC_PER_TNVDA,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\nSaved ${CONFIG_PATH}`);
  console.log(`tNVDA mint: ${explorerAddr(mint.publicKey)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
