# Demo-day checklist

## The night before
- [ ] Phantom on **Devnet** (Settings → Developer Settings → Testnet Mode) with ≥0.5 SOL and ≥20 USDC
      (SOL: `solana transfer <PHANTOM_ADDR> 0.5 --allow-unfunded-recipient`; USDC: https://faucet.circle.com)
- [ ] Treasury has SOL: `solana balance` ≥ 1 (else https://faucet.solana.com)
- [ ] Trading is **not** halted: `npm run halt -- status` → `Trading halted: false`
- [ ] Phantom wallet is **not** whitelisted, so the "blocked" beat works:
      `npm run kyc -- <PHANTOM_ADDR> true true true` marks it sanctioned (blocked), or use a fresh Phantom account.
- [ ] Full dry run of the sequence below, once, on the network you'll present from.

## 30 minutes before
- [ ] Wi-Fi/hotspot connected. (MoonPay binds URLs to your public IP; if you switch networks, just reload the page.)
- [ ] Terminal window A:  `cd ~/tsv_swap && npm start`
- [ ] Terminal window B:  `cd ~/tsv_swap` (for kyc / halt commands), font size bumped up (Cmd +)
- [ ] Browser tab 1: http://localhost:3000, wallet connected
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
| 4 | Window B: `npm run kyc -- <PHANTOM_ADDR>` → Refresh → **WHITELISTED** | "Compliance officer clears them (in production, this is the MoonPay/KYC webhook)." |
| 5 | Execute Compliant Swap → Phantom confirm → CONFIRMED | "Same transaction, now it settles: USDC to the venue, tNVDA to the investor." |
| 6 | Scroll to trade tape (new row, "Reported after: Ns") | "Public tape: masked wallet, size, USD price, immutable signature, reported in seconds — the rule says 10 minutes." |
| 7 | Window B: `npm run halt -- on` → swap → **TradingHalted** | "Trading halt: one switch stops every transfer of the security at the protocol level." |
| 8 | `npm run halt -- off` (say nothing, just reset) | |
| 9 | MoonPay panel → Sign in → amount → Apple Pay sheet | "Fiat on-ramp: verified U.S. person buys USDC by card, delivered to the same wallet." Close at the order screen. |
| 10 | Tab 2 (program) → Transaction History | "Everything you just saw, on-chain, with the three instructions per swap visible." |

## If something breaks

| Symptom | Do |
|---|---|
| Wallet won't connect / page reloaded | Click **Connect wallet** again. |
| "Unverified connection" in MoonPay panel | Reload the page (IP changed). If still failing, skip step 9 and show the order email from the dry run. |
| Phantom refuses to show the popup | Run the terminal version: `npx ts-node --transpile-only scripts/demo-revert.ts` (blocked → whitelist → allowed) |
| 429 / devnet RPC slow | Wait 10 s and retry. Devnet public RPC is rate-limited; nothing is wrong with the program. |
| Wallet somehow whitelisted before step 3 | `npm run kyc -- <PHANTOM_ADDR> true true true` (marks sanctioned) → Refresh, then continue; step 4 un-sanctions it. |
| Server died | Window A: `npm start`. Everything on-chain persists. |

## Reset between demos
```
npm run halt -- off
npm run kyc -- <PHANTOM_ADDR> true true true     # back to "blocked" for the next run
```
