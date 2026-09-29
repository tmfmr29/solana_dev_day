# Demo-day checklist

## The night before
- [ ] Phantom on **Devnet** (Settings → Developer Settings → Testnet Mode) with ≥0.5 SOL and ≥20 USDC
      (SOL: `solana transfer <PHANTOM_ADDR> 0.5 --allow-unfunded-recipient`; USDC: https://faucet.circle.com)
- [ ] Treasury has SOL: `solana balance` ≥ 1 (else https://faucet.solana.com)
- [ ] In the admin console (http://localhost:3000/admin.html): trading **open**, and the Phantom wallet set to
      **Sanction** so the "blocked" beat works. (Terminal equivalents: `npm run halt -- off`, `npm run kyc -- <ADDR> true true true`.)
- [ ] Full dry run of the sequence below, once, on the network you'll present from.

## 30 minutes before
- [ ] Wi-Fi/hotspot connected. (MoonPay binds URLs to your public IP; if you switch networks, just reload the page.)
- [ ] Terminal window A:  `cd ~/tsv_swap && npm start`
- [ ] Terminal window B:  `cd ~/tsv_swap` (fallback only)
- [ ] Browser window 1 (left half of screen): http://localhost:3000, wallet connected
- [ ] Browser window 2 (right half): http://localhost:3000/admin.html — the compliance officer's console
- [ ] Browser tab 2: program on Explorer
      https://explorer.solana.com/address/7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn?cluster=devnet
- [ ] Browser tab 3: tNVDA mint on Explorer (shows the Transfer Hook extension)
      https://explorer.solana.com/address/6RhaBrNoX8iEUiE7iXjpbTbK3UHsYLJhBGX5H6fBcbgc?cluster=devnet
- [ ] Close every other tab. Turn on Do Not Disturb.

## The sequence (≈5 minutes)

| Step | Do | Say |
|---|---|---|
| 1 | Show tab 3 (mint) | "tNVDA is a Token-2022 asset with a transfer hook. Every transfer, anywhere, calls our compliance program first." |
| 2 | Tab 1, status **NOT WHITELISTED / BLOCKED** | "This investor hasn't cleared KYC." |
| 3 | Execute Compliant Swap → pre-flight REVERT, Phantom blocks | "The **network** rejects it, not our UI. The USDC leg and the security leg are one transaction, so nothing moves." |
| 4 | Admin console: click **Whitelist** on the wallet → investor view **Refresh** → **WHITELISTED** | "Compliance officer clears them (in production, the KYC provider's webhook does this)." |
| 5 | Execute Compliant Swap → Phantom confirm → CONFIRMED | "Same transaction, now it settles: USDC to the venue, tNVDA to the investor." |
| 6 | Scroll to trade tape (new row, "Reported after: Ns") | "Public tape: masked wallet, size, USD price, immutable signature, reported in seconds — the rule says 10 minutes." |
| 7 | Admin console: **Halt trading** → investor swap → **TradingHalted** | "Trading halt: one switch stops every transfer of the security at the protocol level, in every wallet." |
| 8 | Admin console: **Resume trading** (say nothing, just reset) | |
| 9 | MoonPay panel → Sign in → amount → Apple Pay sheet | "Fiat on-ramp: verified U.S. person buys USDC by card, delivered to the same wallet." Close at the order screen. |
| 10 | Tab 2 (program) → Transaction History | "Everything you just saw, on-chain, with the three instructions per swap visible." |

## If something breaks

| Symptom | Do |
|---|---|
| Wallet won't connect / page reloaded | Click **Connect wallet** again. |
| "Unverified connection" in MoonPay panel | Reload the page (IP changed). If still failing, skip step 9 and show the order email from the dry run. |
| Phantom refuses to show the popup | Run the terminal version: `npx ts-node --transpile-only scripts/demo-revert.ts` (blocked → whitelist → allowed) |
| 429 / devnet RPC slow | Wait 10 s and retry. Devnet public RPC is rate-limited; nothing is wrong with the program. |
| Wallet somehow whitelisted before step 3 | Admin console → **Sanction** → investor Refresh, then continue; step 4 un-sanctions it. |
| Admin console says "only available from localhost" | You opened it via an IP or hostname; use http://localhost:3000/admin.html exactly. |
| Server died | Window A: `npm start`. Everything on-chain persists. |

## Reset between demos
Admin console: **Resume trading**, then **Sanction** the Phantom wallet (back to "blocked" for the next run).
Terminal equivalent: `npm run halt -- off && npm run kyc -- <PHANTOM_ADDR> true true true`
