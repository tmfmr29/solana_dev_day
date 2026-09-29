import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import { TsvSwap } from "../target/types/tsv_swap";

describe("tsv_swap compliance transfer hook", () => {
  // Use "confirmed" everywhere so reads after a send always see the result.
  const provider = new anchor.AnchorProvider(
    new Connection(process.env.ANCHOR_PROVIDER_URL!, "confirmed"),
    anchor.AnchorProvider.env().wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.TsvSwap as Program<TsvSwap>;
  const connection = provider.connection;
  const admin = provider.wallet as anchor.Wallet; // pays for everything, also the token sender

  const DECIMALS = 6;
  const ONE_TOKEN = BigInt(10 ** DECIMALS);

  // The Token-2022 mint we'll attach the hook to
  const mint = Keypair.generate();

  // Recipients with different compliance states
  const goodUser = Keypair.generate(); // US, not sanctioned, KYC cleared  -> allowed
  const sanctionedUser = Keypair.generate(); // US, SANCTIONED, KYC cleared  -> blocked
  const foreignUser = Keypair.generate(); // NOT US, not sanctioned, cleared -> blocked
  const unclearedUser = Keypair.generate(); // US, not sanctioned, NOT cleared -> blocked

  const ata = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);

  const profilePda = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("compliance"), wallet.toBuffer()],
      program.programId
    )[0];

  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];

  const extraAccountMetaListPda = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    program.programId
  )[0];

  async function setKyc(
    wallet: PublicKey,
    isUsPerson: boolean,
    isOfacSanctioned: boolean,
    kycCleared: boolean,
    signer?: Keypair // defaults to the provider wallet (the admin)
  ) {
    const builder = program.methods
      .updateKycStatus(isUsPerson, isOfacSanctioned, kycCleared)
      .accountsPartial({
        admin: signer ? signer.publicKey : admin.publicKey,
        config: configPda,
        userWallet: wallet,
        complianceProfile: profilePda(wallet),
        systemProgram: SystemProgram.programId,
      });
    await (signer ? builder.signers([signer]) : builder).rpc();
  }

  async function setHalt(halted: boolean) {
    await program.methods.setTradingHalt(halted).accountsPartial({ admin: admin.publicKey, config: configPda }).rpc();
  }

  async function transferTo(recipient: PublicKey, amount: bigint) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection,
      ata(admin.publicKey),
      mint.publicKey,
      ata(recipient),
      admin.publicKey,
      amount,
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    return provider.sendAndConfirm(new Transaction().add(ix));
  }

  /** Asserts the transfer fails and the failure comes from our hook with the named error. */
  async function expectBlocked(recipient: PublicKey, errorName: string, errorHex: string) {
    let failed = false;
    try {
      await transferTo(recipient, ONE_TOKEN);
    } catch (err: any) {
      failed = true;
      const logs: string[] = err.logs ?? err.transactionLogs ?? [];
      const haystack = [err.message ?? "", ...logs].join("\n");
      assert.isTrue(
        haystack.includes(errorName) || haystack.includes(errorHex),
        `Transfer failed, but not with ${errorName}. Got:\n${haystack}`
      );
    }
    assert.isTrue(failed, `Transfer to ${recipient.toBase58()} should have been blocked`);
  }

  it("initializes the config (provider wallet becomes admin)", async () => {
    await program.methods.initializeConfig().accountsPartial({ admin: admin.publicKey, config: configPda, systemProgram: SystemProgram.programId }).rpc();
    const c = await program.account.config.fetch(configPda);
    assert.isTrue(c.admin.equals(admin.publicKey));
    assert.isFalse(c.halted);
  });

  it("REJECTS KYC updates from a non-admin", async () => {
    const impostor = Keypair.generate();
    const sig = await connection.requestAirdrop(impostor.publicKey, 1_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
    let failed = false;
    try { await setKyc(impostor.publicKey, true, false, true, impostor); }
    catch (err: any) { failed = true; assert.include(String(err), "Unauthorized"); }
    assert.isTrue(failed, "non-admin should not be able to whitelist");
  });

  it("writes KYC profiles", async () => {
    await setKyc(admin.publicKey, true, false, true); // the sender must be compliant too
    await setKyc(goodUser.publicKey, true, false, true);
    await setKyc(sanctionedUser.publicKey, true, true, true);
    await setKyc(foreignUser.publicKey, false, false, true);
    await setKyc(unclearedUser.publicKey, true, false, false);

    const p = await program.account.complianceProfile.fetch(profilePda(sanctionedUser.publicKey));
    assert.isTrue(p.walletAddress.equals(sanctionedUser.publicKey));
    assert.isTrue(p.isOfacSanctioned);
  });

  it("creates a Token-2022 mint with the transfer hook pointing at this program", async () => {
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        admin.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        admin.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [mint]);
  });

  it("initializes the extra account meta list for the mint", async () => {
    await program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        extraAccountMetaList: extraAccountMetaListPda,
        mint: mint.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const info = await connection.getAccountInfo(extraAccountMetaListPda);
    assert.isNotNull(info, "extra account meta list should exist");
    assert.isTrue(info!.owner.equals(program.programId));
  });

  it("creates token accounts and mints 100 tokens to the sender", async () => {
    const owners = [admin, goodUser, sanctionedUser, foreignUser, unclearedUser].map(
      (k) => k.publicKey
    );
    const tx = new Transaction();
    for (const owner of owners) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          admin.publicKey,
          ata(owner),
          owner,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    tx.add(
      createMintToInstruction(
        mint.publicKey,
        ata(admin.publicKey),
        admin.publicKey,
        100n * ONE_TOKEN,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx);

    const bal = await getAccount(connection, ata(admin.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(bal.amount, 100n * ONE_TOKEN);
  });

  it("ALLOWS a transfer to a KYC-cleared US person", async () => {
    await transferTo(goodUser.publicKey, 5n * ONE_TOKEN);
    const bal = await getAccount(connection, ata(goodUser.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(bal.amount, 5n * ONE_TOKEN);
  });

  it("BLOCKS a transfer to an OFAC-sanctioned wallet", async () => {
    await expectBlocked(sanctionedUser.publicKey, "SanctionedEntity", "0x1770");
  });

  it("BLOCKS a transfer to a non-US person", async () => {
    await expectBlocked(foreignUser.publicKey, "NotUSPerson", "0x1771");
  });

  it("BLOCKS a transfer to a wallet that has not cleared KYC", async () => {
    await expectBlocked(unclearedUser.publicKey, "KycNotCleared", "0x1772");
  });

  it("BLOCKS everyone while trading is halted, then resumes", async () => {
    await setHalt(true);
    await expectBlocked(goodUser.publicKey, "TradingHalted", "0x1773");
    await setHalt(false);
    await transferTo(goodUser.publicKey, ONE_TOKEN);
  });

  it("ALLOWS the same wallet once the admin clears its KYC", async () => {
    await setKyc(unclearedUser.publicKey, true, false, true);
    await transferTo(unclearedUser.publicKey, ONE_TOKEN);
    const bal = await getAccount(connection, ata(unclearedUser.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(bal.amount, ONE_TOKEN);
  });
});
