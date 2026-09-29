# TSV Swap — compliance that lives inside the token

**Wedge: Infrastructure / compliance.** A tokenized-security venue where the rules are enforced by the asset itself, not by the app.

> 📹 **Demo video:** _[link — 3 minutes]_ · 🌐 **Program on devnet:** [`7Kmj…bxkTn`](https://explorer.solana.com/address/7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn?cluster=devnet)

## The user and the problem

The user is the **compliance officer at a venue that wants to list tokenized U.S. stocks legally**. Today, "only verified U.S. persons may hold this security" is a rule enforced in a database: once a token leaves the venue's app, nothing stops it from moving to a sanctioned wallet, a lending pool, or an offshore account. Regulators know this, which is why tokenized-stock venues are stuck with either no compliance or no composability.

## What this is

A working venue for `tNVDA` (tokenized NVIDIA) against Circle USDC, where every rule is enforced on-chain and every action leaves an auditable, signed record:

- **The rule is in the token.** `tNVDA` is a Token-2022 mint with a transfer hook. Solana calls our program on **every** transfer, from any wallet or app, and refuses to move tokens unless the receiver is a KYC-cleared, non-sanctioned U.S. person and trading isn't halted. Not "our app checks" — the network checks.
- **Compliant settlement.** Buy or sell in one atomic transaction (USDC ⇄ tNVDA), built as a Solana Pay request and signed in Phantom. Fails as a whole if the hook says no.
- **A real operator's console.** Whitelist, sanction, halt trading with one click; a Tier 1 volume-cap monitor that halts automatically; a simulated primary-exchange (Nasdaq) halt feed driving real on-chain halts.
- **Regulatory reporting that proves itself.** Daily / CAT-style T+1 / monthly / quarterly reports with a trade blotter, order lifecycle events, rejected orders, volume-cap tracking and halt log — SHA-256 hashed, chained, and Ed25519-signed by the venue key, verifiable in the browser.
- **An investor app** that hides all of the above: eligibility, portfolio and P&L, a plain-language ticket, add funds by card (MoonPay), statements.
- **Public tape and disclosures.** Every trade published within seconds (10-minute rule), plus the SEC-required public notice.

## Why Solana

Token-2022 transfer hooks are the only mainstream primitive that lets an issuer attach enforceable transfer logic to a fungible asset, so compliance travels with the token into any wallet or protocol. Atomic multi-instruction transactions give delivery-versus-payment settlement in ~2 seconds with no counterparty risk. And it's cheap enough that per-trade compliance checks and per-trade public reporting are free.

## What's real and what's simulated

| Real, on devnet | Simulated / prototype |
|---|---|
| Transfer hook enforcement on every tNVDA transfer | Primary-exchange (Nasdaq) halt feed — button-driven |
| Admin-only KYC, sanctions, halt; auto-halt on cap breach | NVDA ADV benchmark — configured value, not a market-data feed |
| Atomic USDC⇄tNVDA settlement signed in Phantom | Fixed reference price (no AMM curve yet) |
| Signed, chained regulatory reports; CAT-style order events | MoonPay sandbox purchases don't deliver devnet USDC |
| Public trade tape with reporting latency | Corporate actions, Travel Rule, dividends — not built |

## Roadmap

AMM pool with published curve → live LULD/MWCB feed → Travel Rule messaging → corporate-actions pass-through → mainnet with a licensed operator.

---

Everything below is live on **Solana devnet**.

| | |
|---|---|
| Program (transfer hook) | [`7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn`](https://explorer.solana.com/address/7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn?cluster=devnet) |
| tNVDA mint (Token-2022, hook attached) | [`6RhaBrNoX8iEUiE7iXjpbTbK3UHsYLJhBGX5H6fBcbgc`](https://explorer.solana.com/address/6RhaBrNoX8iEUiE7iXjpbTbK3UHsYLJhBGX5H6fBcbgc?cluster=devnet) |
| Settlement asset | Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Features

**On-chain program (Anchor, Token-2022 transfer hook)**
- Hook runs on every tNVDA transfer; checks trading halt, OFAC flags on both parties, receiver is a KYC-cleared U.S. person, and that it's being invoked by Token-2022 mid-transfer (anti-spoof).
- Admin-only configuration PDA: whitelist changes and halts require the venue admin key.
- On-chain `security.txt`; 12-case end-to-end test suite on a local validator.

**Trading & settlement**
- Buy **and sell** tNVDA against Circle USDC in one atomic transaction (delivery-versus-payment), built server-side as a Solana Pay transaction request and signed in Phantom/Backpack.
- Pre-flight simulation shows the on-chain verdict before the wallet prompt; every request is an **order** with an ID written into the transaction as a memo.
- MoonPay sandbox on-ramp with signed, IP-bound widget URLs.

**Compliance operations (admin console)**
- Per-wallet KYC flags (US person / OFAC sanctioned / KYC cleared) with one-click whitelist, sanction, revoke.
- Trading halt switch; **Tier 1 volume-cap monitor** (MTD volume vs. % of NVDA ADV) that halts automatically on breach and records a 3-month pause on a second breach.
- Simulated primary-exchange feed (LULD pause / market-wide circuit breaker) driving real on-chain halts, with source attribution.
- Listing / issuer-notice card; persisted audit trail of every admin and automated action with on-chain signatures.

**Regulatory reporting**
- Signed report packages (HTML print view, JSON envelope, CSV tables): trade blotter, daily OHLC/VWAP summary, compliance events, rejected orders, **CAT-style order lifecycle file** (MENO/MEOR/MEOT/MEOC), **volume cap & ADV tracking** with breach/circuit-breaker log, quarterly roll-up.
- SHA-256 content hash, chained to the previous report, Ed25519-signed by the venue key; the reports dashboard verifies all three in the browser.
- Scheduled: 20:00 ET daily, 07:30 ET CAT T+1, monthly on the 1st, quarterly on Jan/Apr/Jul/Oct. On demand for any range.

**Investor experience**
- Eligibility banner, portfolio with average cost and realized/unrealized P&L, plain-language buy/sell ticket with review step, add funds (card or receive-USDC QR), activity with CSV statement. Compliance failures read as sentences, not error codes.

**Public transparency**
- Trade tape (masked wallet, size, USD price, reporting latency, tx signature) within seconds; pool metrics; JSON/CSV feeds; public notice & disclosures page.

## Pages

| Page | Who | What |
|---|---|---|
| `/investor.html` | investor | Eligibility, portfolio & P&L, buy/sell ticket with pre-trade compliance check, add funds (MoonPay / receive USDC), activity + CSV statement |
| `/admin.html` | compliance officer | KYC flags & sanctions per wallet, trading halt, Tier 1 volume-cap monitor (auto-halt), simulated primary-exchange halt feed, listing/issuer notice, regulatory report generation, audit trail |
| `/reports.html` | compliance officer | Regulatory reports dashboard: period summary, daily activity, trade blotter, compliance events, rejected orders, volume cap & ADV tracking (monthly/quarterly), CAT-style daily order file, attestation with in-browser hash/signature/chain verification |
| `/tape.html` | public | 10-minute trade tape with pool metrics; JSON/CSV feeds |
| `/disclosures.html` | public | Public notice: operator, SEC disclaimer, permissioning criteria, fees, clearing, prohibited activity, halts, volume limits, MEV policy, records retention |
| `/` | engineering | Original demo view with pre-flight logs, venue metrics and tape |

## Regulatory reporting

Reports are generated on demand (today / yesterday / month / quarter / custom range) or on schedule:
20:00 ET daily end-of-day, 07:30 ET CAT T+1 file for the prior day, 1st of month 07:45 ET monthly (quarterly on Jan/Apr/Jul/Oct).
Each package under `devnet/reports/<id>/` holds `report.html` (print view), `report.json` (signed envelope), and CSV tables
(trade blotter, daily summary, compliance events, rejected orders, CAT daily file, volume cap monthly + log).
Every swap request is an **order** with an ID written into the transaction as a memo, so executions link back to origination
(MENO → MEOR → MEOT, or MEOC on rejection/expiry). Reports are SHA-256 hashed, chained to the previous report, and Ed25519-signed
by the venue admin key; the dashboard verifies all three in the browser.

Set `RPC_URL` in `app/.env` to a dedicated devnet endpoint (e.g. Helius) — the public RPC rate-limits and will block a busy demo.

## Repository layout

```
programs/tsv_swap/src/lib.rs   the on-chain program (Anchor): config, KYC profiles, halt, transfer hook
tests/tsv_swap.ts              end-to-end test on a local validator (12 cases)
scripts/                       devnet tooling: setup-tnvda, kyc, halt, demo-revert, demo-swap
app/server.ts                  server: Solana Pay swap builder (buy/sell), admin API, order book of record,
                               tape indexer, volume-cap monitor, report generator + schedulers, MoonPay signing
app/public/investor.html       investor app
app/public/admin.html          compliance officer console
app/public/reports.html        regulatory reports dashboard (with in-browser verification)
app/public/tape.html           public trade tape
app/public/disclosures.html    public notice
app/public/index.html          engineering view
devnet/                        config.json (addresses), venue.json, audit.json, tape.json, orders.json, reports/
DEMO.md · VIDEO_SCRIPT.md      demo-day checklist and video script
```

## Program instructions

| Instruction | Who | Purpose |
|---|---|---|
| `initialize_config` | first caller | Creates the config PDA; caller becomes admin. Runs once. |
| `set_trading_halt(bool)` | admin | Halt / resume all transfers. |
| `update_kyc_status(us, sanctioned, cleared)` | admin | Create or update a wallet's compliance profile (PDA keyed by wallet). |
| `initialize_extra_account_meta_list` | admin | Per mint: tells Token-2022 which extra accounts to pass to the hook. |
| `execute_transfer(amount)` | Token-2022 only | The hook. Enforces the rules above. |

## Running it

Prereqs: Rust, Solana/Agave CLI 4.x, Anchor 1.2, Node 20+. A Phantom or Backpack wallet on devnet
with a little SOL ([faucet](https://faucet.solana.com)) and USDC ([Circle faucet](https://faucet.circle.com)).

```bash
npm install
anchor test --validator legacy          # local end-to-end test suite

# devnet
solana config set --url devnet
anchor deploy --provider.cluster devnet
npm run setup:devnet                    # config, tNVDA mint, hook wiring, treasury, initial supply
npm run kyc -- <WALLET>                 # whitelist an investor wallet (admin only)
npm run halt -- on|off|status           # trading halt

cp app/.env.example app/.env            # add MoonPay sandbox keys and RPC_URL
npm start                               # dashboard at http://localhost:3000
```

Terminal demo of the protocol-level revert (no browser needed):

```bash
npx ts-node --transpile-only scripts/demo-revert.ts
```

## Demo walkthrough

Investor app on the left, admin console on the right (see `DEMO.md` for the full checklist).

1. Investor connects → **Trading restricted** (sanctioned wallet). Buy → refused at pre-flight by the transfer hook.
2. Admin console → **Whitelist** → investor refreshes → **eligible** → Buy → Confirm in Phantom → **Filled ✔**, settled in ~2 s.
3. Admin → **Simulate LULD pause** → investor sees a red halt banner → Buy → refused (`TradingHalted`). **Primary resumes.**
4. Admin → volume-cap gauge: set a small ADV, trade past the cap → automatic halt, breach logged.
5. Reports dashboard → **Since last** → blotter, CAT events, rejected order, halt → **Verify** → hash, signature and chain all green.
6. Public tape shows each trade with its reporting latency; disclosures page carries the SEC notice.

## Attribution

Built by Tim Fitzpatrick for Solana Dev Day. Open-source components: Anchor, `@solana/web3.js`, `@solana/spl-token`, SPL transfer-hook interface, Express. MoonPay (sandbox) and Circle devnet USDC for on-ramp and settlement. Developed with AI pair-programming assistance (Claude); all design decisions, deployment and testing by the author.

## Notes and limitations

- Prototype: fixed price, single treasury counterparty rather than an AMM pool.
- MoonPay sandbox purchases are simulated and do not deliver devnet USDC.
- Devnet only. Not audited. Do not use with real funds.
