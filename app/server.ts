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

function toCsv(rows: Record<string, any>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
app.get("/api/tape.csv", (_req, res) => {
  const rows = [...tape.values()].sort((a, b) => b.blockTime - a.blockTime).map((t) => ({
    executed_utc: new Date(t.blockTime * 1000).toISOString(), wallet_masked: t.buyerMasked, usdc_in: t.usdcIn, tnvda_out: t.tnvdaOut,
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

app.listen(PORT, () => {
  console.log(`TSV Swap demo running at http://localhost:${PORT}`);
  console.log(`Treasury ${TREASURY.toBase58()}  tNVDA ${TNVDA.toBase58()}  price ${cfg.priceUsdcPerTnvda} USDC/tNVDA`);
  console.log(`MoonPay key: ${process.env.MOONPAY_PUBLISHABLE_KEY ? "set" : "NOT SET (add app/.env)"}; secret for signed URLs: ${process.env.MOONPAY_SECRET_KEY ? "set" : "not set"}`);
});
