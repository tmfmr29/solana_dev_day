// Admin tool: set a wallet's compliance profile.
// Usage: npx ts-node --transpile-only scripts/kyc.ts <WALLET> [us=true] [sanctioned=false] [cleared=true]
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { setup, profilePda, configPda, explorerTx, mask } from "./lib";

export async function setKyc(
  program: any,
  admin: PublicKey,
  wallet: PublicKey,
  isUs: boolean,
  sanctioned: boolean,
  cleared: boolean
): Promise<string> {
  return program.methods
    .updateKycStatus(isUs, sanctioned, cleared)
    .accountsPartial({
      admin,
      config: configPda(program.programId),
      userWallet: wallet,
      complianceProfile: profilePda(program.programId, wallet),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

async function main() {
  const [walletArg, us = "true", sanctioned = "false", cleared = "true"] = process.argv.slice(2);
  if (!walletArg) throw new Error("usage: kyc.ts <WALLET> [us] [sanctioned] [cleared]");
  const { admin, program } = setup();
  const wallet = new PublicKey(walletArg);
  const sig = await setKyc(program, admin.publicKey, wallet, us === "true", sanctioned === "true", cleared === "true");
  console.log(`KYC profile for ${mask(wallet)}: us=${us} sanctioned=${sanctioned} cleared=${cleared}`);
  console.log(explorerTx(sig));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
