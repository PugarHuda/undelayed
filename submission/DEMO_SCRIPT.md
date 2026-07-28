# Demo script — Undelayed

Target ~3 minutes. Record your own voice; AI narration is disqualified. Speak
plainly, no jargon padding.

**Beat 1 — the wrong mental model (0:00–0:20)**
Screen: the dashboard, Coston2, with the red "on-chain reads" column visible.

> "This is Flare's FAssets direct minting. One XRP payment, FXRP on the other
> side. The chain says sixteen thousand XRP has been minted in today's window.
> That number is wrong. The window it belongs to expired twenty-six hours ago."

**Beat 2 — why it is wrong (0:20–0:50)**
Screen: scroll to the explanation block, then flash `NOTES.md`.

> "The limiter isn't a tumbling window. Every window that passes subtracts one
> whole limit instead of resetting, so overspend carries forward. Read this from
> the verified contract, not the docs. And a mint above the large threshold skips
> both limiters entirely."

**Beat 3 — what goes wrong for a merchant (0:50–1:10)**
Screen: terminal, `npm run probe -- coston2 120000`.

> "When a limit binds, the mint doesn't fail. It goes quiet. The XRP is already
> at the core vault, the payment is already recorded, and nothing arrives. So
> people send a second payment and pay twice, or they retry early and burn the
> proof they paid for."

**Beat 4 — the answer (1:10–1:30)**
Screen: the simulator, type an amount, watch the verdict flip.

> "Undelayed replays the limiter exactly as the contract runs it. Ask it when
> your mint is allowed and it tells you, before you send anything."

**Beat 5 — the merchant rail (1:30–2:00)**
Screen: `npm run pay -- 205 5`, then the explorer showing FXRP arriving.

> "Here's a checkout. The merchant reserved tag two-oh-five in Flare's own tag
> manager — we didn't write that contract, Flare already ships it. The customer
> sends five XRP with that destination tag from any wallet. Four point eight
> FXRP lands at the merchant's address. The difference is the system fee and the
> executor fee."

**Beat 6 — the executor (2:00–2:30)**
Screen: `npm run bot -- --tags 205` output.

> "Someone has to prove the payment to Flare and finalise it. That's the bot. It
> requests an FDC attestation, waits for the voting round, and executes. If the
> mint is delayed it waits for allowedAt instead of retrying — retrying early
> reverts and wastes the proof."

**Beat 7 — the honest bit (2:30–2:50)**
Screen: the first run's `PaymentAlreadyConfirmed` line.

> "The first time we ran this, another executor beat us. Our call reverted, our
> proof fee was gone, and the merchant got paid anyway. We left that in. It's the
> clearest statement of why knowing the timing is worth anything."

**Beat 8 — close (2:50–3:00)**
Screen: dashboard with the network toggle, click through to Flare mainnet.

> "Same code, mainnet. Undelayed."

---

**Shots to capture before recording**
- Dashboard on Coston2 during a quiet window, so the red stale column is visible.
  If both windows are current the contrast disappears — check before rolling.
- The explorer page for the FXRP transfer, zoomed to the amount.
- The bot's terminal output at a readable font size.
