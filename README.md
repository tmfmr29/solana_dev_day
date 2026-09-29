# TSV Swap — Compliant Tokenized-Security Venue on Solana

A working prototype of a **tokenized-security venue (TSV)** under the SEC's exemption model:
a tokenized security (`tNVDA`) that can only move between whitelisted, KYC-cleared U.S. persons,
paired against Circle USDC for settlement, funded through MoonPay, and reported on a public
trade tape within the 10-minute transparency window.

Everything below is live on **Solana devnet**.

| | |
|---|---|
| Program (transfer hook) | [`7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn`](https://explorer.solana.com/address/7KmjcBRHVjjhqxjihdJAFvfukbjhnNP82QPpVevbxkTn?cluster=devnet) |
| tNVDA mint (Token-2022, hook attached) | [`6RhaBrNoX8iEUiE7iXjpbTbK3UHsYLJhBGX5H6fBcbgc`](https://explorer.solana.com/address/6RhaBrNoX8iEUiE7iXjpbTbK3UHsYLJhBGX5H6fBcbgc?cluster=devnet) |
| Settlement asset | Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## What it does

1. **Compliance enforced by the protocol, not the app.** `tNVDA` is a Token-2022 mint with a
   *transfer hook* pointing at this program. Token-2022 calls the hook on **every** transfer, from
   any wallet or app, and refuses to move tokens unless the hook approves. The hook checks:
   - a global **trading halt** flag (admin switch),
   - the sender and receiver are not **OFAC-sanctioned**,
   - the receiver is a **verified U.S. person** who has **cleared KYC**,
   - it is being invoked by Token-2022 mid-transfer (not called directly).
2. **Compliant swap.** One atomic transaction: buyer's USDC → treasury, treasury's tNVDA → buyer.
   Built as a Solana Pay transaction request and signed in Phantom/Backpack. If the buyer isn't
   whitelisted, the *whole* transaction is rejected by the network.
3. **Fiat on-ramp.** MoonPay sandbox widget (signed, IP-bound URLs) so a verified U.S. person can
   buy USDC with a card and land it in the wallet that then swaps.
4. **10-minute reporting tape.** An indexer watches the treasury and publishes each trade
   (masked wallet, USDC in, tNVDA out, USD price, reporting latency, tx signature) within seconds.

## Repository layout

```
programs/tsv_swap/src/lib.rs   the on-chain program (Anchor)
tests/tsv_swap.ts              end-to-end test on a local validator (12 cases)
scripts/                       devnet tooling: setup-tnvda, kyc, halt, demo-revert, demo-swap
app/server.ts                  dashboard server: Solana Pay endpoint, MoonPay signing, trade tape
app/public/index.html          the dashboard
devnet/config.json             addresses of the deployed devnet setup
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

cp app/.env.example app/.env            # add MoonPay sandbox keys (optional)
npm start                               # dashboard at http://localhost:3000
```

Terminal demo of the protocol-level revert (no browser needed):

```bash
npx ts-node --transpile-only scripts/demo-revert.ts
```

## Demo script

1. Connect a wallet → status **NOT WHITELISTED**.
2. Execute swap → pre-flight shows the network will revert (`AccountNotInitialized`), wallet blocks it.
3. `npm run kyc -- <WALLET>` → refresh → **WHITELISTED**.
4. Execute swap → confirmed; appears on the trade tape within seconds with an explorer link.
5. `npm run halt -- on` → swap → `TradingHalted`. `npm run halt -- off` → swap → confirmed.
6. MoonPay panel: buy USDC with a sandbox card, delivered to the connected wallet.

## Notes and limitations

- Prototype: fixed price, single treasury counterparty rather than an AMM pool.
- MoonPay sandbox purchases are simulated and do not deliver devnet USDC.
- Devnet only. Not audited. Do not use with real funds.
