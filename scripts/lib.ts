// Shared helpers for the devnet scripts.
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const DEVNET_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC
export const TNVDA_DECIMALS = 6;
export const CONFIG_PATH = path.join(__dirname, "..", "devnet", "config.json");
export const MINT_KEYPAIR_PATH = path.join(__dirname, "..", "devnet", "tnvda-mint.json");

export function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file.replace("~", os.homedir()), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function saveKeypair(file: string, kp: Keypair) {
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
}

export function adminKeypair(): Keypair {
  return loadKeypair(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
}

export function setup() {
  const admin = adminKeypair();
  const connection = new Connection(DEVNET_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "tsv_swap.json"), "utf8")
  );
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;
  return { admin, connection, provider, program };
}

export type DevnetConfig = {
  programId: string;
  tnvdaMint: string;
  usdcMint: string;
  treasury: string; // admin wallet pubkey
  treasuryTnvdaAta: string;
  treasuryUsdcAta: string;
  usdcTokenProgram: string;
  extraAccountMetaList: string;
  priceUsdcPerTnvda: number;
};

export function loadConfig(): DevnetConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No ${CONFIG_PATH}. Run: npx ts-node --transpile-only scripts/setup-tnvda.ts`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

export function profilePda(programId: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("compliance"), wallet.toBuffer()],
    programId
  )[0];
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function extraMetasPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    programId
  )[0];
}

/** Token program that owns a mint (classic Token or Token-2022), or null if the mint doesn't exist. */
export async function tokenProgramFor(connection: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(mint);
  return info ? info.owner : null;
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a: PublicKey | string) =>
  `https://explorer.solana.com/address/${a.toString()}?cluster=devnet`;

export function mask(pk: PublicKey | string): string {
  const s = pk.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
