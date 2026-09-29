// TSV Swap demo server.
//  - Serves the dashboard (app/public)
//  - Solana Pay transaction request:  GET/POST /api/swap?usdc=<amount>
//      builds ONE atomic transaction: buyer USDC -> treasury, treasury tNVDA -> buyer.
//      The tNVDA leg runs through the compliance transfer hook, so a non-whitelisted
//      buyer makes the whole transaction revert at the protocol level.
//  - GET /api/kyc/:wallet   compliance profile for a wallet
//  - GET /api/tape          public trade tape (10-minute reporting)
//  - GET /api/config        public config for the page (mint addresses, MoonPay key)
// Run: npx ts-node --transpile-only app/server.ts
import express from "express";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { setup, loadConfig, profilePda, configPda, TNVDA_DECIMALS, mask } from "../scripts/lib";

const USDC_DECIMALS = 6;
const PORT = Number(process.env.PORT ?? 3000);

// Optional app/.env with MOONPAY_PUBLISHABLE_KEY=pk_test_...
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}

const { admin, connection, program } = setup();
const cfg = loadConfig();
const TNVDA = new PublicKey(cfg.tnvdaMint);
const USDC = new PublicKey(cfg.usdcMint);
const USDC_PROGRAM = new PublicKey(cfg.usdcTokenProgram);
const TREASURY = admin.publicKey;
const TREASURY_TNVDA = new PublicKey(cfg.treasuryTnvdaAta);
const TREASURY_USDC = new PublicKey(cfg.treasuryUsdcAta);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    cluster: "devnet",
    programId: cfg.programId,
    tnvdaMint: cfg.tnvdaMint,
    usdcMint: cfg.usdcMint,
    treasury: cfg.treasury,
    priceUsdcPerTnvda: cfg.priceUsdcPerTnvda,
    moonpayPublishableKey: process.env.MOONPAY_PUBLISHABLE_KEY ?? null,
  });
});

// MoonPay widget URL. Signed (HMAC-SHA256 of the query string) and bound to the customer's
// public IP, as MoonPay requires. The page sends the IPs it sees for itself (?ips=a,b); we
// build a candidate URL per IP and ask MoonPay's verify endpoint which one it accepts, since
// the browser may reach MoonPay over IPv4 or IPv6 depending on the network.
app.get("/api/moonpay-url", async (req, res) => {
  const pk = process.env.MOONPAY_PUBLISHABLE_KEY;
  if (!pk) return res.status(400).json({ error: "MOONPAY_PUBLISHABLE_KEY not set" });
  const sk = process.env.MOONPAY_SECRET_KEY;
  const base = () => {
    const url = new URL("https://buy-sandbox.moonpay.com/");
    url.searchParams.set("apiKey", pk);
    url.searchParams.set("currencyCode", "usdc_sol");
    url.searchParams.set("baseCurrencyCode", "usd");
    url.searchParams.set("baseCurrencyAmount", "100");
    return url;
  };
  if (!sk || !req.query.wallet) return res.json({ url: base().toString(), signed: false });

  const ips = String(req.query.ips ?? req.query.ip ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/^::ffff:/, "")).filter(Boolean);
  const sign = (ip: string | null) => {
    const url = base();
    url.searchParams.set("walletAddress", String(req.query.wallet));
    if (ip) url.searchParams.set("allowedIpAddress", crypto.createHmac("sha256", sk).update(ip).digest("base64"));
    const signature = crypto.createHmac("sha256", sk).update(url.search).digest("base64");
    return `${url.toString()}&signature=${encodeURIComponent(signature)}`;
  };
  const candidates: (string | null)[] = [...ips, null];
  for (const ip of candidates) {
    const url = sign(ip);
    try {
      const r = await fetch("https://api.moonpay.com/v3/verify_widget_signature", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.success) return res.json({ url, signed: true, ipBound: !!ip, ip });
      console.log(`moonpay verify (${ip ?? "no ip"}): ${j.message ?? r.status}`);
    } catch (e: any) { console.log(`moonpay verify error: ${e.message}`); }
  }
  // Nothing verified; return the last candidate so the widget shows MoonPay's own error.
  res.json({ url: sign(ips[0] ?? null), signed: true, ipBound: ips.length > 0, verified: false });
});

app.get("/api/kyc/:wallet", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const p = await (program.account as any).complianceProfile.fetchNullable(profilePda(program.programId, wallet));
    if (!p) return res.json({ wallet: wallet.toBase58(), exists: false });
    res.json({
      wallet: wallet.toBase58(), exists: true,
      isUsPerson: p.isUsPerson, isOfacSanctioned: p.isOfacSanctioned, kycCleared: p.kycCleared,
      compliant: p.isUsPerson && !p.isOfacSanctioned && p.kycCleared,
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---- Solana Pay transaction request ----------------------------------------
app.get("/api/swap", (_req, res) => {
  res.json({ label: "TSV Compliant Swap", icon: `${_req.protocol}://${_req.get("host")}/icon.svg` });
});

app.post("/api/swap", async (req, res) => {
  try {
    const buyer = new PublicKey(req.body.account);
    const usdcAmount = Number(req.query.usdc ?? req.body.usdc);
    if (!(usdcAmount > 0)) throw new Error("usdc amount must be > 0");
    const usdcBase = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));
    const tnvdaBase = usdcBase / BigInt(cfg.priceUsdcPerTnvda); // both have 6 decimals

    const buyerUsdc = getAssociatedTokenAddressSync(USDC, buyer, false, USDC_PROGRAM);
    const buyerTnvda = getAssociatedTokenAddressSync(TNVDA, buyer, false, TOKEN_2022_PROGRAM_ID);

    const tx = new Transaction();
    // 1. Make sure the buyer has a tNVDA account (buyer pays rent).
    tx.add(createAssociatedTokenAccountIdempotentInstruction(buyer, buyerTnvda, buyer, TNVDA, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    // 2. Settlement leg: buyer USDC -> treasury (signed by buyer's wallet).
    tx.add(createTransferCheckedInstruction(buyerUsdc, USDC, TREASURY_USDC, buyer, usdcBase, USDC_DECIMALS, [], USDC_PROGRAM));
    // 3. Security leg: treasury tNVDA -> buyer, through the compliance hook (signed by treasury here).
    //    We append the hook's extra accounts ourselves (instead of the spl-token helper) because the
    //    buyer's token account may not exist yet — it is created in this same transaction.
    const hookIx = createTransferCheckedInstruction(TREASURY_TNVDA, TNVDA, buyerTnvda, TREASURY, tnvdaBase, TNVDA_DECIMALS, [], TOKEN_2022_PROGRAM_ID);
    const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    hookIx.keys.push(
      ro(profilePda(program.programId, TREASURY)),       // source_profile
      ro(profilePda(program.programId, buyer)),          // destination_profile
      ro(configPda(program.programId)),                  // config (trading-halt flag)
      ro(program.programId),                             // the hook program
      ro(new PublicKey(cfg.extraAccountMetaList)),       // validation account
    );
    tx.add(hookIx);

    tx.feePayer = buyer;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.partialSign(admin); // treasury signs its leg; buyer signs in their wallet

    // Preview: simulate so the UI can show the on-chain verdict before the wallet prompt.
    const sim = await connection.simulateTransaction(tx).catch(() => null);
    const logs: string[] = sim?.value?.logs ?? [];
    const errLine = logs.find((l) => l.includes("Error Code:"));
    const preview = sim?.value?.err
      ? { ok: false, reason: errLine?.replace(/.*Error Code: /, "").trim() ?? JSON.stringify(sim.value.err) }
      : { ok: true, reason: null };

    res.json({
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message: `Swap ${usdcAmount} USDC for ${Number(tnvdaBase) / 10 ** TNVDA_DECIMALS} tNVDA`,
      tnvdaOut: Number(tnvdaBase) / 10 ** TNVDA_DECIMALS,
      preview,
    });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// ---- Public trade tape -----------------------------------------------------
type Trade = { signature: string; blockTime: number; reportedAt: number; buyer: string; buyerMasked: string; usdcIn: number; tnvdaOut: number; latencySec: number; backfilled?: boolean };
const TAPE_PATH = path.join(__dirname, "..", "devnet", "tape.json");
const tape = new Map<string, Trade>();
try { for (const t of JSON.parse(fs.readFileSync(TAPE_PATH, "utf8")) as Trade[]) tape.set(t.signature, t); } catch {}
const serverStartedAt = Math.floor(Date.now() / 1000);
const seen = new Set<string>([...tape.keys()]); // every signature we've already inspected (swap or not)
const saveTape = () => fs.writeFileSync(TAPE_PATH, JSON.stringify([...tape.values()], null, 2));

async function refreshTape() {
  const sigs = await connection.getSignaturesForAddress(TREASURY_USDC, { limit: 20 }, "confirmed");
  for (const s of sigs) {
    if (seen.has(s.signature)) continue;
    seen.add(s.signature);
    if (s.err) continue;
    const tx = await connection.getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) { seen.delete(s.signature); continue; } // not available yet; look again next time
    await new Promise((r) => setTimeout(r, 300)); // be gentle with the public RPC
    const delta = new Map<string, number>(); // key: owner|mint -> ui amount change
    for (const b of tx.meta.preTokenBalances ?? []) delta.set(`${b.owner}|${b.mint}`, -(b.uiTokenAmount.uiAmount ?? 0));
    for (const b of tx.meta.postTokenBalances ?? []) {
      const k = `${b.owner}|${b.mint}`;
      delta.set(k, (delta.get(k) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
    }
    const usdcIn = delta.get(`${cfg.treasury}|${cfg.usdcMint}`) ?? 0;
    const tnvdaFromTreasury = -(delta.get(`${cfg.treasury}|${cfg.tnvdaMint}`) ?? 0);
    if (usdcIn <= 0 || tnvdaFromTreasury <= 0) continue; // not a swap
    const buyerEntry = [...delta.entries()].find(([k, v]) => k.endsWith(`|${cfg.tnvdaMint}`) && !k.startsWith(cfg.treasury) && v > 0);
    const buyer = buyerEntry ? buyerEntry[0].split("|")[0] : "unknown";
    const now = Math.floor(Date.now() / 1000);
    const blockTime = s.blockTime ?? now;
    // A trade that happened before this server process started was reported by a previous
    // run (or never); we can't measure its latency now, so mark it back-filled.
    const backfilled = blockTime < serverStartedAt - 30;
    tape.set(s.signature, {
      signature: s.signature, blockTime, reportedAt: now,
      buyer, buyerMasked: mask(buyer), usdcIn, tnvdaOut: tnvdaFromTreasury,
      latencySec: backfilled ? 0 : Math.max(0, now - blockTime), backfilled,
    });
    saveTape();
  }
}
setInterval(() => refreshTape().catch((e) => console.error("tape:", String(e.message).slice(0, 80))), 15000);
refreshTape().catch(() => {});

app.get("/api/tape", (_req, res) => {
  res.json([...tape.values()].sort((a, b) => b.blockTime - a.blockTime).slice(0, 50));
});

app.listen(PORT, () => {
  console.log(`TSV Swap demo running at http://localhost:${PORT}`);
  console.log(`Treasury ${TREASURY.toBase58()}  tNVDA ${TNVDA.toBase58()}  price ${cfg.priceUsdcPerTnvda} USDC/tNVDA`);
  console.log(`MoonPay key: ${process.env.MOONPAY_PUBLISHABLE_KEY ? "set" : "NOT SET (add app/.env)"}; secret for signed URLs: ${process.env.MOONPAY_SECRET_KEY ? "set" : "not set"}`);
});
