# Demo video script (target 2:30–3:00)

Record with QuickTime → File → New Screen Recording, microphone on. Browser windows: investor app (left), admin console (right).
Keep the cursor slow. If something fails, pause recording, fix, resume — cut later or just re-record that beat.

**0:00 — Hook (say over the investor app, wallet connected, status BLOCKED)**
"Tokenized stocks already trade on Solana. The problem is compliance: the rule 'only verified U.S. investors may hold this' lives in a database, and stops working the moment a token leaves the app. We put the rule inside the token."

**0:20 — The blocked trade**
Investor app → Buy 1 USDC worth → Review order.
"This wallet hasn't cleared KYC. Watch: the venue doesn't refuse — the *Solana network* refuses. The order can't execute because the token's own transfer hook rejects the receiver. That's true in any wallet, any app, forever."

**0:45 — Whitelist and trade**
Admin console → Whitelist → investor app Refresh → Buy → Confirm in Phantom → Filled ✔.
"Compliance officer clears them — one click, one on-chain transaction. Same order: USDC to the venue, tNVDA to the investor, one atomic transaction, settled in two seconds."

**1:10 — Halt**
Admin console → Simulate LULD pause → investor app shows red banner → try to buy → refused.
"Nasdaq halts NVDA: the venue halts tNVDA at the protocol level, concurrently, in every wallet. Regulator calls at 2am? Same switch."
→ Primary resumes.

**1:35 — Volume cap (optional if time)**
Admin console → point at cap gauge. "Tier 1 cap: 0.25% of NVDA's ADV per month, monitored from the tape; breach halts automatically."

**1:50 — Reporting**
Reports dashboard → Since last → open report → scroll: blotter, CAT events, rejected order, halt → click Verify → green.
"Everything you just saw is already a regulatory report: the blotter, the order lifecycle in CAT format, the rejected order, the halt with its on-chain signature. Hashed, chained to the previous report, signed by the venue key — and verified right here in the browser. Daily, T+1, monthly and quarterly runs are scheduled."

**2:25 — Public tape + close**
Public tape page briefly. "Every trade public within seconds; the rule says ten minutes."
Back to investor app. "For the investor, none of this is visible — just a portfolio and a plain-language ticket. Compliance inside the token, settlement in seconds, reporting that proves itself. That's what belongs on Solana."

**Before recording**
- [ ] Reset: Resume trading; Sanction the Phantom wallet (so the first trade is blocked)
- [ ] Phantom has USDC and SOL; server running with RPC_URL set
- [ ] Close other tabs, Do Not Disturb on, font zoom 110–125% in the browser
