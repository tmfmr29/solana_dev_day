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
import bs58 from "bs58";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
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
const CONFIG_PDA = configPda(program.programId);

// ---- Venue settings + audit trail (persisted in devnet/) --------------------
const VENUE_PATH = path.join(__dirname, "..", "devnet", "venue.json");
const AUDIT_PATH = path.join(__dirname, "..", "devnet", "audit.json");
type Venue = {
  nvdaAdvShares: number;      // consolidated average daily volume of NVDA (shares) — configurable for the demo
  capPct: number;             // Tier 1 monthly cap as % of ADV
  breaches: { month: string; at: number; mtdVolume: number; cap: number }[];
  primaryMarket: { status: "OPEN" | "HALTED"; reason: string | null; since: number };
  listing: { issuer: string; ticker: string; noticeSentAt: string; objectionWindowEnds: string; status: string };
};
const venue: Venue = Object.assign({
  nvdaAdvShares: 200_000_000, capPct: 0.25, breaches: [],
  primaryMarket: { status: "OPEN", reason: null, since: Math.floor(Date.now() / 1000) },
  listing: { issuer: "NVIDIA Corporation", ticker: "NVDA", noticeSentAt: "2026-08-15", objectionWindowEnds: "2026-09-14", status: "Listed — no issuer objection received" },
}, (() => { try { return JSON.parse(fs.readFileSync(VENUE_PATH, "utf8")); } catch { return {}; } })());
const saveVenue = () => fs.writeFileSync(VENUE_PATH, JSON.stringify(venue, null, 2));

type AuditEntry = { ts: number; actor: string; action: string; details: string; signature?: string };
const audit: AuditEntry[] = (() => { try { return JSON.parse(fs.readFileSync(AUDIT_PATH, "utf8")); } catch { return []; } })();
function logAudit(e: Omit<AuditEntry, "ts">) {
  audit.push({ ts: Math.floor(Date.now() / 1000), ...e });
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));
  console.log(`audit: [${e.actor}] ${e.action} — ${e.details}`);
}

async function setHaltOnChain(halted: boolean, actor: string, reason: string): Promise<string> {
  const sig = await program.methods.setTradingHalt(halted).accountsPartial({ admin: TREASURY, config: CONFIG_PDA }).rpc();
  logAudit({ actor, action: halted ? "TRADING_HALT" : "TRADING_RESUME", details: reason, signature: sig });
  return sig;
}

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

// ---- Admin console (localhost only) -----------------------------------------
// These endpoints sign with the treasury/admin key, so only accept requests from this machine.
const localOnly: express.RequestHandler = (req, res, next) => {
  const ip = (req.ip ?? "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return next();
  res.status(403).json({ error: "admin endpoints are only available from localhost" });
};

app.get("/api/admin/state", localOnly, async (_req, res) => {
  try {
    const c = await (program.account as any).config.fetchNullable(CONFIG_PDA);
    const all = await (program.account as any).complianceProfile.all();
    const profiles = all.map((p: any) => ({
      wallet: p.account.walletAddress.toBase58(),
      isUsPerson: p.account.isUsPerson, isOfacSanctioned: p.account.isOfacSanctioned, kycCleared: p.account.kycCleared,
      compliant: p.account.isUsPerson && !p.account.isOfacSanctioned && p.account.kycCleared,
      isTreasury: p.account.walletAddress.equals(TREASURY),
    })).sort((a: any, b: any) => (a.isTreasury ? -1 : b.isTreasury ? 1 : a.wallet.localeCompare(b.wallet)));
    res.json({ admin: c?.admin?.toBase58() ?? null, halted: c?.halted ?? null, treasury: TREASURY.toBase58(), profiles });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

app.post("/api/admin/kyc", localOnly, async (req, res) => {
  try {
    const wallet = new PublicKey(req.body.wallet);
    const { isUsPerson, isOfacSanctioned, kycCleared } = req.body;
    const sig = await program.methods
      .updateKycStatus(!!isUsPerson, !!isOfacSanctioned, !!kycCleared)
      .accountsPartial({ admin: TREASURY, config: CONFIG_PDA, userWallet: wallet, complianceProfile: profilePda(program.programId, wallet), systemProgram: SystemProgram.programId })
      .rpc();
    logAudit({ actor: "compliance officer (admin console)", action: "KYC_UPDATE",
      details: `${wallet.toBase58()} us=${!!isUsPerson} sanctioned=${!!isOfacSanctioned} cleared=${!!kycCleared}`, signature: sig });
    res.json({ signature: sig });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

app.post("/api/admin/halt", localOnly, async (req, res) => {
  try {
    const sig = await setHaltOnChain(!!req.body.halted, "compliance officer (admin console)", req.body.reason ?? "manual");
    res.json({ signature: sig });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Simulated primary-exchange feed (Nasdaq). In production this is a listener on the
// exchange's regulatory feed (LULD pauses, market-wide circuit breakers); the halt it
// triggers on-chain is real.
app.post("/api/admin/primary-market", localOnly, async (req, res) => {
  try {
    const event = String(req.body.event ?? "").toUpperCase();
    const now = Math.floor(Date.now() / 1000);
    let sig: string | undefined;
    if (event === "RESUME") {
      venue.primaryMarket = { status: "OPEN", reason: null, since: now };
      sig = await setHaltOnChain(false, "primary-market feed (simulated Nasdaq)", "NVDA trading resumed on primary exchange");
    } else {
      const reason = event === "MWCB" ? "Market-wide circuit breaker (Level 1) on primary exchange"
                   : event === "NEWS" ? "News-pending regulatory halt on NVDA"
                   : "LULD trading pause on NVDA (price outside limit band)";
      venue.primaryMarket = { status: "HALTED", reason, since: now };
      sig = await setHaltOnChain(true, "primary-market feed (simulated Nasdaq)", reason);
    }
    saveVenue();
    res.json({ signature: sig, primaryMarket: venue.primaryMarket });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

app.post("/api/admin/venue", localOnly, (req, res) => {
  if (req.body.nvdaAdvShares) venue.nvdaAdvShares = Number(req.body.nvdaAdvShares);
  if (req.body.capPct) venue.capPct = Number(req.body.capPct);
  if (req.body.resetBreaches) venue.breaches = [];
  saveVenue();
  logAudit({ actor: "compliance officer (admin console)", action: "VENUE_SETTINGS", details: `ADV=${venue.nvdaAdvShares} capPct=${venue.capPct}${req.body.resetBreaches ? " breaches reset" : ""}` });
  res.json({ ok: true, venue });
});

app.get("/api/audit", localOnly, (_req, res) => res.json([...audit].reverse().slice(0, 200)));
app.get("/api/audit.csv", localOnly, (_req, res) => {
  res.type("text/csv").send(toCsv(audit.map((a) => ({ timestamp_utc: new Date(a.ts * 1000).toISOString(), actor: a.actor, action: a.action, details: a.details, signature: a.signature ?? "" }))));
});

// ---- Solana Pay transaction request ----------------------------------------
app.get("/api/swap", (_req, res) => {
  res.json({ label: "TSV Compliant Swap", icon: `${_req.protocol}://${_req.get("host")}/icon.svg` });
});

app.post("/api/swap", async (req, res) => {
  try {
    const investor = new PublicKey(req.body.account);
    const side = String(req.query.side ?? req.body.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy";
    // Amount may be given in USDC (usdc=) or in tNVDA (tnvda=); both have 6 decimals.
    let usdcBase: bigint, tnvdaBase: bigint;
    if (req.query.tnvda ?? req.body.tnvda) {
      tnvdaBase = BigInt(Math.round(Number(req.query.tnvda ?? req.body.tnvda) * 10 ** TNVDA_DECIMALS));
      usdcBase = tnvdaBase * BigInt(cfg.priceUsdcPerTnvda);
    } else {
      const usdcAmount = Number(req.query.usdc ?? req.body.usdc);
      if (!(usdcAmount > 0)) throw new Error("amount must be > 0");
      usdcBase = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));
      tnvdaBase = usdcBase / BigInt(cfg.priceUsdcPerTnvda);
    }
    if (tnvdaBase <= 0n) throw new Error("amount too small");

    const investorUsdc = getAssociatedTokenAddressSync(USDC, investor, false, USDC_PROGRAM);
    const investorTnvda = getAssociatedTokenAddressSync(TNVDA, investor, false, TOKEN_2022_PROGRAM_ID);
    const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
    const tx = new Transaction();

    if (side === "buy") {
      // 1. Make sure the buyer has a tNVDA account (buyer pays rent).
      tx.add(createAssociatedTokenAccountIdempotentInstruction(investor, investorTnvda, investor, TNVDA, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      // 2. Settlement leg: buyer USDC -> treasury (signed by buyer's wallet).
      tx.add(createTransferCheckedInstruction(investorUsdc, USDC, TREASURY_USDC, investor, usdcBase, USDC_DECIMALS, [], USDC_PROGRAM));
      // 3. Security leg: treasury tNVDA -> buyer, through the compliance hook (signed by treasury here).
      //    We append the hook's extra accounts ourselves (instead of the spl-token helper) because the
      //    buyer's token account may not exist yet — it is created in this same transaction.
      const hookIx = createTransferCheckedInstruction(TREASURY_TNVDA, TNVDA, investorTnvda, TREASURY, tnvdaBase, TNVDA_DECIMALS, [], TOKEN_2022_PROGRAM_ID);
      hookIx.keys.push(ro(profilePda(program.programId, TREASURY)), ro(profilePda(program.programId, investor)), ro(configPda(program.programId)), ro(program.programId), ro(new PublicKey(cfg.extraAccountMetaList)));
      tx.add(hookIx);
    } else {
      // SELL: investor tNVDA -> treasury (through the hook, signed by the investor),
      //       treasury USDC -> investor (signed by treasury). Same atomicity guarantee.
      tx.add(createAssociatedTokenAccountIdempotentInstruction(investor, investorUsdc, investor, USDC, USDC_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID));
      const hookIx = createTransferCheckedInstruction(investorTnvda, TNVDA, TREASURY_TNVDA, investor, tnvdaBase, TNVDA_DECIMALS, [], TOKEN_2022_PROGRAM_ID);
      hookIx.keys.push(ro(profilePda(program.programId, investor)), ro(profilePda(program.programId, TREASURY)), ro(configPda(program.programId)), ro(program.programId), ro(new PublicKey(cfg.extraAccountMetaList)));
      tx.add(hookIx);
      tx.add(createTransferCheckedInstruction(TREASURY_USDC, USDC, investorUsdc, TREASURY, usdcBase, USDC_DECIMALS, [], USDC_PROGRAM));
    }
    const buyer = investor; // fee payer / signer in the wallet

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
    if (!preview.ok) recordRejected({ wallet: investor.toBase58(), side, tnvda: Number(tnvdaBase) / 10 ** TNVDA_DECIMALS, usdc: Number(usdcBase) / 10 ** USDC_DECIMALS, reason: preview.reason ?? "unknown" });

    const usdcUi = Number(usdcBase) / 10 ** USDC_DECIMALS, tnvdaUi = Number(tnvdaBase) / 10 ** TNVDA_DECIMALS;
    res.json({
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message: side === "buy" ? `Swap ${usdcUi} USDC for ${tnvdaUi} tNVDA` : `Sell ${tnvdaUi} tNVDA for ${usdcUi} USDC`,
      side, usdc: usdcUi, tnvda: tnvdaUi, tnvdaOut: side === "buy" ? tnvdaUi : 0, price: cfg.priceUsdcPerTnvda,
      preview,
    });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// ---- Public trade tape -----------------------------------------------------
type Trade = { signature: string; blockTime: number; reportedAt: number; side: "buy" | "sell"; buyer: string; buyerMasked: string; usdcIn: number; tnvdaOut: number; latencySec: number; backfilled?: boolean };
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
    const tUsdc = delta.get(`${cfg.treasury}|${cfg.usdcMint}`) ?? 0;   // + on a buy, - on a sell
    const tTnvda = delta.get(`${cfg.treasury}|${cfg.tnvdaMint}`) ?? 0;  // - on a buy, + on a sell
    let side: "buy" | "sell";
    if (tUsdc > 0 && tTnvda < 0) side = "buy"; else if (tUsdc < 0 && tTnvda > 0) side = "sell"; else continue; // not a swap
    const usdcIn = Math.abs(tUsdc), tnvdaFromTreasury = Math.abs(tTnvda);
    const buyerEntry = [...delta.entries()].find(([k, v]) => k.endsWith(`|${cfg.tnvdaMint}`) && !k.startsWith(cfg.treasury) && v !== 0);
    const buyer = buyerEntry ? buyerEntry[0].split("|")[0] : "unknown";
    const now = Math.floor(Date.now() / 1000);
    const blockTime = s.blockTime ?? now;
    // A trade that happened before this server process started was reported by a previous
    // run (or never); we can't measure its latency now, so mark it back-filled.
    const backfilled = blockTime < serverStartedAt - 30;
    tape.set(s.signature, {
      signature: s.signature, blockTime, reportedAt: now, side,
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

function toCsv(rows: Record<string, any>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
app.get("/api/tape.csv", (_req, res) => {
  const rows = [...tape.values()].sort((a, b) => b.blockTime - a.blockTime).map((t) => ({
    executed_utc: new Date(t.blockTime * 1000).toISOString(), side: t.side ?? "buy", wallet_masked: t.buyerMasked, usdc: t.usdcIn, tnvda: t.tnvdaOut,
    usd_price: (t.usdcIn / t.tnvdaOut).toFixed(2), reported_after_sec: t.backfilled ? "" : t.latencySec, signature: t.signature,
  }));
  res.type("text/csv").send(toCsv(rows));
});

// ---- Tier 1 volume cap monitor ----------------------------------------------
// Monthly tNVDA volume on this venue must stay under capPct% of NVDA's consolidated ADV.
// A breach records itself and halts trading on-chain automatically.
const monthKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);
function volumeCapStatus() {
  const month = monthKey(Math.floor(Date.now() / 1000));
  const trades = [...tape.values()].filter((t) => monthKey(t.blockTime) === month);
  const mtdVolume = trades.reduce((a, t) => a + t.tnvdaOut, 0);
  const cap = venue.nvdaAdvShares * venue.capPct / 100;
  return { month, mtdVolume, cap, pct: cap > 0 ? (mtdVolume / cap) * 100 : 0, trades: trades.length,
           breaches: venue.breaches, breachedThisMonth: venue.breaches.some((b) => b.month === month), nvdaAdvShares: venue.nvdaAdvShares, capPct: venue.capPct };
}
let capCheckInFlight = false;
async function checkVolumeCap() {
  if (capCheckInFlight) return;
  const st = volumeCapStatus();
  if (st.mtdVolume <= st.cap || st.breachedThisMonth) return;
  capCheckInFlight = true;
  try {
    venue.breaches.push({ month: st.month, at: Math.floor(Date.now() / 1000), mtdVolume: st.mtdVolume, cap: st.cap });
    saveVenue();
    const nth = venue.breaches.length;
    logAudit({ actor: "volume-cap monitor", action: "VOLUME_CAP_BREACH", details: `Breach #${nth}: MTD ${st.mtdVolume} tNVDA > cap ${st.cap} (${st.capPct}% of ADV ${st.nvdaAdvShares})` });
    await setHaltOnChain(true, "volume-cap monitor", nth >= 2 ? `Second breach of Tier 1 cap — 3-month pause required` : `Tier 1 monthly volume cap breached`);
  } catch (e: any) { console.error("cap:", e.message); }
  finally { capCheckInFlight = false; }
}
setInterval(() => checkVolumeCap().catch(() => {}), 5000);

// ---- Venue metrics (pool transparency / end-of-day size) -------------------
let poolCache: { at: number; data: any } | null = null;
async function poolMetrics() {
  if (poolCache && Date.now() - poolCache.at < 30000) return poolCache.data;
  const [t, u] = await Promise.all([
    connection.getTokenAccountBalance(TREASURY_TNVDA).then((r) => Number(r.value.uiAmount)).catch(() => null),
    connection.getTokenAccountBalance(TREASURY_USDC).then((r) => Number(r.value.uiAmount)).catch(() => null),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  const today = [...tape.values()].filter((x) => new Date(x.blockTime * 1000).toISOString().slice(0, 10) === day);
  const data = {
    poolAddress: TREASURY.toBase58(), programId: cfg.programId, tnvdaMint: cfg.tnvdaMint, usdcMint: cfg.usdcMint,
    tnvdaLiquidity: t, usdcLiquidity: u, priceUsdcPerTnvda: cfg.priceUsdcPerTnvda,
    dayUtc: day, dailyTrades: today.length, dailyTnvdaVolume: today.reduce((a, x) => a + x.tnvdaOut, 0), dailyUsdcVolume: today.reduce((a, x) => a + x.usdcIn, 0),
    asOf: new Date().toISOString(),
  };
  poolCache = { at: Date.now(), data };
  return data;
}
app.get("/api/venue", async (_req, res) => {
  const c = await (program.account as any).config.fetchNullable(CONFIG_PDA).catch(() => null);
  res.json({ halted: c?.halted ?? null, volumeCap: volumeCapStatus(), primaryMarket: venue.primaryMarket, listing: venue.listing, pool: await poolMetrics() });
});

// ---- Rejected orders (compliance refusals seen at pre-flight) ----------------
type Rejected = { ts: number; wallet: string; side: string; tnvda: number; usdc: number; reason: string; code: string };
const REJECTED_PATH = path.join(__dirname, "..", "devnet", "rejected.json");
const rejected: Rejected[] = (() => { try { return JSON.parse(fs.readFileSync(REJECTED_PATH, "utf8")); } catch { return []; } })();
function recordRejected(r: Omit<Rejected, "ts" | "code">) {
  const code = (r.reason.match(/^[A-Za-z]+/)?.[0]) ?? "Unknown";
  rejected.push({ ts: Math.floor(Date.now() / 1000), code, ...r });
  fs.writeFileSync(REJECTED_PATH, JSON.stringify(rejected, null, 2));
}

// ---- Regulatory reporting ------------------------------------------------------
// Report package: JSON envelope + CSV tables + human-readable HTML, content-hashed (SHA-256),
// chained to the previous report, and attested with an ed25519 signature by the venue admin key.
const REPORTS_DIR = path.join(__dirname, "..", "devnet", "reports");
const REPORTS_INDEX = path.join(REPORTS_DIR, "index.json");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
type ReportMeta = { id: string; seq: number; type: string; from: number; to: number; generatedAt: number; generatedBy: string; trades: number; hash: string; prevHash: string | null; signature: string; files: string[] };
const reportsIndex: ReportMeta[] = (() => { try { return JSON.parse(fs.readFileSync(REPORTS_INDEX, "utf8")); } catch { return []; } })();

const ET = "America/New_York";
function etParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o: any = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute, date: `${o.year}-${o.month}-${o.day}` };
}
function etOffsetMs(d: Date) { // ms to add to an ET wall-clock "as if UTC" instant to get the real instant
  const p = etParts(d);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return Math.round((d.getTime() - asUtc) / 60000) * 60000;
}
/** [from, to) in unix seconds for an ET calendar day given as YYYY-MM-DD */
function etDayBounds(ymd: string): [number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 12, 0); // noon to pick the right offset for that day
  const off = etOffsetMs(new Date(naive));
  const start = Date.UTC(y, m - 1, d, 0, 0) + off, end = Date.UTC(y, m - 1, d + 1, 0, 0) + off;
  return [Math.floor(start / 1000), Math.floor(end / 1000)];
}
const fmtTs = (ts: number) => new Date(ts * 1000).toISOString();
const fmtEt = (ts: number) => new Date(ts * 1000).toLocaleString("en-US", { timeZone: ET, hour12: false }) + " ET";

async function generateReport(type: string, from: number, to: number, generatedBy: string): Promise<ReportMeta> {
  const now = Math.floor(Date.now() / 1000);
  const trades = [...tape.values()].filter((t) => t.blockTime >= from && t.blockTime < to).sort((a, b) => a.blockTime - b.blockTime);
  const events = audit.filter((a) => a.ts >= from && a.ts < to);
  const rej = rejected.filter((r) => r.ts >= from && r.ts < to);
  const all = await (program.account as any).complianceProfile.all().catch(() => []);
  const roster = { total: all.length,
    eligible: all.filter((p: any) => p.account.isUsPerson && !p.account.isOfacSanctioned && p.account.kycCleared).length,
    restricted: all.filter((p: any) => p.account.isOfacSanctioned || !p.account.isUsPerson).length,
    pending: all.filter((p: any) => p.account.isUsPerson && !p.account.isOfacSanctioned && !p.account.kycCleared).length };
  const pool = await poolMetrics();
  const c = await (program.account as any).config.fetchNullable(CONFIG_PDA).catch(() => null);

  const blotter = trades.map((t, i) => ({
    trade_id: t.signature, seq: i + 1, executed_utc: fmtTs(t.blockTime), executed_et: fmtEt(t.blockTime),
    symbol: "tNVDA", underlying: "NVDA", venue_side: (t.side ?? "buy") === "buy" ? "SELL" : "BUY", customer_side: (t.side ?? "buy").toUpperCase(),
    quantity: t.tnvdaOut, price_usd: +(t.usdcIn / t.tnvdaOut).toFixed(6), notional_usd: t.usdcIn, settlement_asset: "USDC", settlement_amount: t.usdcIn,
    counterparty_id: crypto.createHash("sha256").update(t.buyer).digest("hex").slice(0, 16), counterparty_masked: t.buyerMasked,
    settlement_status: "SETTLED", settled_utc: fmtTs(t.blockTime), public_report_latency_sec: t.backfilled ? "" : t.latencySec, late_report: !t.backfilled && t.latencySec > 600 ? "Y" : "N",
  }));
  const byDay = new Map<string, typeof trades>();
  for (const t of trades) { const k = etParts(new Date(t.blockTime * 1000)).date; (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(t); }
  const daily = [...byDay.entries()].map(([day, ts]) => {
    const px = ts.map((t) => t.usdcIn / t.tnvdaOut), vol = ts.reduce((a, t) => a + t.tnvdaOut, 0), notional = ts.reduce((a, t) => a + t.usdcIn, 0);
    return { trading_day_et: day, trades: ts.length, share_volume: +vol.toFixed(6), notional_usd: +notional.toFixed(2), vwap_usd: +(notional / vol).toFixed(4),
      open: px[0], high: Math.max(...px), low: Math.min(...px), close: px[px.length - 1], unique_counterparties: new Set(ts.map((t) => t.buyer)).size,
      buys: ts.filter((t) => (t.side ?? "buy") === "buy").length, sells: ts.filter((t) => t.side === "sell").length };
  });
  const evRows = events.map((e) => ({ timestamp_utc: fmtTs(e.ts), timestamp_et: fmtEt(e.ts), event: e.action, actor: e.actor, details: e.details, onchain_signature: e.signature ?? "" }));
  const rejRows = rej.map((r) => ({ timestamp_utc: fmtTs(r.ts), wallet_masked: mask(r.wallet), counterparty_id: crypto.createHash("sha256").update(r.wallet).digest("hex").slice(0, 16), side: r.side.toUpperCase(), quantity: r.tnvda, notional_usd: r.usdc, rejection_code: r.code, reason: r.reason }));
  const cap = volumeCapStatus();

  const seq = (reportsIndex[reportsIndex.length - 1]?.seq ?? 0) + 1;
  const prevHash = reportsIndex[reportsIndex.length - 1]?.hash ?? null;
  const id = `${type}-${new Date(from * 1000).toISOString().slice(0, 10)}-${String(seq).padStart(4, "0")}`;
  const body = {
    report: { id, sequence: seq, type, schema: "tsv-regulatory-report/1", venue: "Digital Vector Solutions — Tokenized Securities Venue (devnet prototype)", operator_contact: "tim.mindray@gmail.com",
      period_start_utc: fmtTs(from), period_end_utc: fmtTs(to), period_start_et: fmtEt(from), period_end_et: fmtEt(to), generated_at_utc: fmtTs(now), generated_by: generatedBy,
      program_id: cfg.programId, security_mint: cfg.tnvdaMint, settlement_mint: cfg.usdcMint, pool_address: cfg.treasury, previous_report_hash: prevHash },
    summary: { trades: trades.length, share_volume: +trades.reduce((a, t) => a + t.tnvdaOut, 0).toFixed(6), notional_usd: +trades.reduce((a, t) => a + t.usdcIn, 0).toFixed(2),
      rejected_orders: rej.length, compliance_events: events.length, halts: events.filter((e) => e.action === "TRADING_HALT").length, cap_breaches: events.filter((e) => e.action === "VOLUME_CAP_BREACH").length,
      late_public_reports: blotter.filter((b) => b.late_report === "Y").length, trading_halted_at_period_end: c?.halted ?? null, primary_market_at_period_end: venue.primaryMarket.status,
      volume_cap: { month: cap.month, mtd_share_volume: cap.mtdVolume, cap_shares: cap.cap, pct_used: +cap.pct.toFixed(4), breaches_on_record: cap.breaches.length },
      pool_end_of_period: { tnvda_liquidity: pool.tnvdaLiquidity, usdc_liquidity: pool.usdcLiquidity, price_usd: pool.priceUsdcPerTnvda }, participants: roster },
    trade_blotter: blotter, daily_summary: daily, compliance_events: evRows, rejected_orders: rejRows,
  };
  const canonical = JSON.stringify(body);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  // Ed25519 signature by the venue admin key (same key that administers the on-chain program).
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(admin.secretKey.slice(0, 32))]);
  const signature = bs58.encode(crypto.sign(null, Buffer.from(hash, "hex"), crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })));
  const attestation = { statement: "The venue operator attests that this report is a complete record of the venue's activity for the stated period.", content_sha256: hash, signer: TREASURY.toBase58(), algorithm: "ed25519 over sha256 bytes", signature };
  const envelope = { ...body, attestation };

  const dir = path.join(REPORTS_DIR, id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(envelope, null, 2));
  fs.writeFileSync(path.join(dir, "trade_blotter.csv"), toCsv(blotter));
  fs.writeFileSync(path.join(dir, "daily_summary.csv"), toCsv(daily));
  fs.writeFileSync(path.join(dir, "compliance_events.csv"), toCsv(evRows));
  fs.writeFileSync(path.join(dir, "rejected_orders.csv"), toCsv(rejRows));
  fs.writeFileSync(path.join(dir, "report.html"), renderReportHtml(envelope));
  const meta: ReportMeta = { id, seq, type, from, to, generatedAt: now, generatedBy, trades: trades.length, hash, prevHash, signature, files: ["report.html", "report.json", "trade_blotter.csv", "daily_summary.csv", "compliance_events.csv", "rejected_orders.csv"] };
  reportsIndex.push(meta); fs.writeFileSync(REPORTS_INDEX, JSON.stringify(reportsIndex, null, 2));
  logAudit({ actor: generatedBy, action: "REGULATORY_REPORT", details: `${id}: ${trades.length} trades, ${rej.length} rejections, ${events.length} events; sha256 ${hash.slice(0, 16)}…` });
  return meta;
}

function renderReportHtml(r: any): string {
  const esc = (v: any) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const table = (rows: any[], cols?: string[]) => {
    if (!rows.length) return `<p class="muted">None in period.</p>`;
    const c = cols ?? Object.keys(rows[0]);
    return `<table><thead><tr>${c.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${c.map((x) => `<td>${esc(row[x])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  };
  const kv = (o: any) => `<table class="kv">${Object.entries(o).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${typeof v === "object" && v ? esc(JSON.stringify(v)) : esc(v)}</td></tr>`).join("")}</table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.report.id)}</title>
<style>body{font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:32px;max-width:1200px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.6px;color:#555;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top;word-break:break-all}th{background:#f3f4f6}table.kv th{width:260px}.muted{color:#777}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px}.box{border:1px solid #ddd;background:#fafafa;padding:10px 12px;border-radius:6px}@media print{body{margin:12px}}</style></head><body>
<h1>Regulatory Activity Report — ${esc(r.report.venue)}</h1>
<div class="muted">Report ${esc(r.report.id)} · sequence ${r.report.sequence} · type ${esc(r.report.type)} · generated ${esc(r.report.generated_at_utc)} by ${esc(r.report.generated_by)}</div>
<div class="muted">Period ${esc(r.report.period_start_et)} → ${esc(r.report.period_end_et)} (${esc(r.report.period_start_utc)} → ${esc(r.report.period_end_utc)})</div>
<h2>1 · Venue identification</h2>${kv({ operator_contact: r.report.operator_contact, program_id: r.report.program_id, security_mint: r.report.security_mint, settlement_mint: r.report.settlement_mint, pool_address: r.report.pool_address, previous_report_hash: r.report.previous_report_hash ?? "(first report)" })}
<h2>2 · Period summary</h2>${kv(r.summary)}
<h2>3 · Trade blotter (${r.trade_blotter.length})</h2>${table(r.trade_blotter, ["seq","executed_et","customer_side","quantity","price_usd","notional_usd","settlement_amount","counterparty_id","counterparty_masked","settlement_status","public_report_latency_sec","late_report","trade_id"])}
<h2>4 · Daily summary</h2>${table(r.daily_summary)}
<h2>5 · Compliance events (${r.compliance_events.length})</h2>${table(r.compliance_events)}
<h2>6 · Rejected orders (${r.rejected_orders.length})</h2>${table(r.rejected_orders)}
<h2>7 · Attestation</h2><div class="box">${esc(r.attestation.statement)}<br><br><span class="mono">content_sha256: ${esc(r.attestation.content_sha256)}<br>signer (venue admin key): ${esc(r.attestation.signer)}<br>signature (${esc(r.attestation.algorithm)}): ${esc(r.attestation.signature)}</span><br><br><span class="muted">Verify: recompute SHA-256 over the canonical JSON body (all fields except <i>attestation</i>) and check the ed25519 signature against the signer's public key. Each trade_id is a Solana transaction signature that can be independently confirmed on-chain.</span></div>
<p class="muted" style="margin-top:28px">This venue is a devnet prototype and is not registered with or endorsed by the U.S. Securities and Exchange Commission.</p>
</body></html>`;
}

// Daily end-of-day report at 20:00 ET, covering that ET trading day.
let lastDailyFor: string | null = reportsIndex.filter((r) => r.type === "daily").map((r) => etParts(new Date(r.from * 1000)).date).pop() ?? null;
setInterval(async () => {
  const p = etParts(new Date());
  if (p.h >= 20 && lastDailyFor !== p.date) {
    lastDailyFor = p.date;
    const [from, to] = etDayBounds(p.date);
    try { await generateReport("daily", from, to, "scheduler (20:00 ET daily)"); } catch (e: any) { console.error("daily report:", e.message); }
  }
}, 60000);

app.get("/api/admin/reports", localOnly, (_req, res) => res.json({ reports: [...reportsIndex].reverse(), nextDaily: "20:00 ET", lastDailyFor }));
app.post("/api/admin/report", localOnly, async (req, res) => {
  try {
    const type = String(req.body.type ?? "adhoc");
    let from: number, to: number;
    const now = Math.floor(Date.now() / 1000), today = etParts(new Date()).date;
    if (type === "today") [from, to] = etDayBounds(today);
    else if (type === "yesterday") { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); [from, to] = etDayBounds(etParts(d).date); }
    else if (type === "month") { const [f] = etDayBounds(today.slice(0, 8) + "01"); from = f; to = now; }
    else if (type === "since_last") { from = reportsIndex[reportsIndex.length - 1]?.to ?? 0; to = now; }
    else { from = Math.floor(new Date(req.body.from).getTime() / 1000); to = Math.floor(new Date(req.body.to).getTime() / 1000); if (!(from < to)) throw new Error("invalid range"); }
    to = Math.min(to, now);
    const meta = await generateReport(type === "adhoc" ? "adhoc" : type, from, to, "compliance officer (admin console)");
    res.json(meta);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
app.use("/reports", localOnly, express.static(REPORTS_DIR));

// ---- Investor endpoints ------------------------------------------------------
function walletTrades(wallet: string) {
  return [...tape.values()].filter((t) => t.buyer === wallet).sort((a, b) => a.blockTime - b.blockTime);
}
app.get("/api/portfolio/:wallet", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const [tnvda, usdc, prof, c] = await Promise.all([
      connection.getTokenAccountBalance(getAssociatedTokenAddressSync(TNVDA, wallet, false, TOKEN_2022_PROGRAM_ID)).then((r) => Number(r.value.uiAmount)).catch(() => 0),
      connection.getTokenAccountBalance(getAssociatedTokenAddressSync(USDC, wallet, false, USDC_PROGRAM)).then((r) => Number(r.value.uiAmount)).catch(() => 0),
      (program.account as any).complianceProfile.fetchNullable(profilePda(program.programId, wallet)),
      (program.account as any).config.fetchNullable(CONFIG_PDA),
    ]);
    // Average-cost basis from this wallet's trades on the venue.
    let qty = 0, cost = 0, realized = 0;
    for (const t of walletTrades(wallet.toBase58())) {
      const side = t.side ?? "buy";
      if (side === "buy") { qty += t.tnvdaOut; cost += t.usdcIn; }
      else { const avg = qty > 0 ? cost / qty : 0; realized += t.usdcIn - avg * t.tnvdaOut; cost -= avg * t.tnvdaOut; qty -= t.tnvdaOut; }
    }
    const price = cfg.priceUsdcPerTnvda;
    const avgCost = qty > 0 ? cost / qty : null;
    const eligibility = !prof ? { status: "unverified", label: "Not yet verified", detail: "Complete identity verification to trade." }
      : prof.isOfacSanctioned ? { status: "restricted", label: "Trading restricted", detail: "Your account is restricted following sanctions screening. Contact compliance." }
      : !prof.isUsPerson ? { status: "restricted", label: "Not eligible", detail: "This venue is open to verified U.S. persons only." }
      : !prof.kycCleared ? { status: "pending", label: "Verification pending", detail: "Your identity verification has not cleared yet." }
      : { status: "eligible", label: "Verified U.S. investor · eligible to trade", detail: null };
    res.json({
      wallet: wallet.toBase58(), eligibility, halted: c?.halted ?? null, primaryMarket: venue.primaryMarket,
      holdings: { tnvda, usdc, price, tnvdaValue: tnvda * price, avgCost, unrealized: avgCost == null ? 0 : (price - avgCost) * tnvda, realized, totalValue: tnvda * price + usdc },
    });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
app.get("/api/activity/:wallet", (req, res) => {
  const rows = walletTrades(req.params.wallet).reverse().map((t) => ({ ...t, side: t.side ?? "buy", price: t.usdcIn / t.tnvdaOut }));
  if (req.query.format === "csv") {
    return res.type("text/csv").attachment("tsv-statement.csv").send(toCsv(rows.map((t) => ({
      executed_utc: new Date(t.blockTime * 1000).toISOString(), side: t.side, tnvda: t.tnvdaOut, usdc: t.usdcIn, price_usd: t.price.toFixed(2), signature: t.signature }))));
  }
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`TSV Swap demo running at http://localhost:${PORT}`);
  console.log(`Treasury ${TREASURY.toBase58()}  tNVDA ${TNVDA.toBase58()}  price ${cfg.priceUsdcPerTnvda} USDC/tNVDA`);
  console.log(`MoonPay key: ${process.env.MOONPAY_PUBLISHABLE_KEY ? "set" : "NOT SET (add app/.env)"}; secret for signed URLs: ${process.env.MOONPAY_SECRET_KEY ? "set" : "not set"}`);
});
