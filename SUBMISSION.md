# Undelayed — Flare Summer Signal submission

**Bounty:** Interoperable Assets (Bounty 1)
**One line:** A merchant rail for FXRP direct minting, plus the only tool that tells you when a direct minting will actually execute.

---

## Prior work — declared up front

Our other submission to this program, **Buta** (Bounty 2), is the sixth build of a
sealed-bid OTC thesis we have shipped on five other chains; that submission
declares its lineage in full. **Undelayed and TagRail are not part of that
lineage.** Nothing here is ported. Every line was written during this program,
against FAssets v1.3 on Coston2, and the behaviour it encodes was read off the
verified `AssetManager` diamond rather than out of documentation.

---

## The problem, stated as a problem

FAssets v1.3 added direct minting: one ordinary XRPL payment to the core vault
mints FXRP on Flare, with no collateral reservation and no agent selection. It is
the first FXRP flow a merchant could plausibly put behind a checkout button.

It also has a behaviour that quietly breaks naive integrations: **when a rate
limit binds, the minting does not fail. It goes silent and executes later.** The
XRP is already at the core vault. The payment is already recorded. Nothing
reverts, nothing refunds, and the FXRP simply is not there yet.

Integrators handle this in one of two wrong ways. They treat the missing FXRP as
a failure and send a second XRPL payment — paying twice for one order. Or they
retry the execution early, which reverts `DirectMintingStillDelayed` and burns
the gas and the FDC proof they paid for.

Reading the chain does not save you, because **the getters do not mean what they
look like they mean:**

- `getDirectMintingHourlyLimiterState()` returns the *stored* window, which goes
  stale between writes. On a quiet Coston2 afternoon it reported 16,285 XRP used
  today while the window it belonged to had expired 26 hours earlier. The real
  figure was zero.
- The limiter is **not a tumbling window**. Each elapsed window subtracts one
  whole limit from the recorded total instead of resetting it, so overspend
  carries forward and `allowedAt = windowStart + windowSize × minted / max`. A
  mint of five times the limit waits roughly five windows, not "until the next
  hour".
- A mint **at or above the large-mint threshold skips both limiters entirely**,
  is delayed by a fixed period, and consumes no window quota at all.
- The state getters return raw AMG while the limit getters convert to UBA.
  Comparing them directly is a units bug for any asset whose
  `assetMintingGranularityUBA()` is not 1.

**Who this is for:** merchants accepting XRP for goods priced on Flare, and the
executors who race to finalise those payments for the executor fee.

---

## What it does

**Undelayed** replays the limiter off-chain, exactly as the contract runs it, and
answers the one question every integrator has: *if I mint X XRP right now, when
is execution allowed?* It ships as a TypeScript module, a CLI, and a dashboard
that shows the raw getter value and the real one side by side.

**TagRail** is the merchant half. A merchant reserves a minting tag in Flare's
official `MintingTagManager`, points it at their Flare address, and shows the
core vault address plus that destination tag at checkout. The customer sends an
ordinary XRP payment from any wallet or exchange. An executor bot proves the
payment with the FDC and finalises it, taking the executor fee.

**TagRail adds no contracts of its own.** Flare already ships the tag manager, and
duplicating protocol infrastructure is not a product. What did not exist is the
merchant flow, the executor that survives the delay rules, and the predictor both
depend on.

---

## Proven on Coston2, not described

| Step | Evidence |
|---|---|
| Tag reserved in the official manager | tag **205**, tx `0xcf83447c87cce1b9d27dd12b9046b27fd9c1151efc696725bd5349503a68f6da` |
| Customer pays 5 XRP with `DestinationTag: 205` | XRPL tx `DCD6E28B7218B454391505B0321E351CAB839BE6910025FCBE550E1680600A47` |
| Merchant receives FXRP | **4.8 FTestXRP**, tx `0x4eb2ec845191…` — the 0.2 XRP difference is the system minting fee plus the 0.1 XRP executor fee |
| FDC round trip | attestation requested on-chain `0x933435849b9313114482febb29600cd91c5765b8848d8919daf61b730cd61ae1`, fee 1000 wei, voting round 1407655, proof pulled from the DA layer and decoded |
| Executor exclusivity | `setAllowedExecutor(205, …)` tx `0x4ed0882223fd5561b6fe49a51dc66b42321454fb44772bcc0ebee00365a22e0b`, active after the 600s cooldown |
| **Our own bot finalises a payment** | 7 XRP in (XRPL `6465EFFF817AFD17CB68A3C7B59D9942678E1650C308E4D058755BE7050AC07B`) → `0x595a419cde1614b7e912dacde0733b6be57d832fce1fea1f4595a26c5fd95e0f` splits it exactly as `_computeFees` says: **0.1 FXRP system fee, 6.8 to the merchant, 0.1 executor fee to us** |

Contracts used (all Flare's own, resolved through the ContractRegistry at
`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`):

- `AssetManagerFXRP` — Coston2 `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`, Flare `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8`
- `MintingTagManager` — Coston2 `0x094511737909b626391106bBc21B25feb2D67B96`
- `FdcHub` `0x48aC463d7975828989331F4De43341627b9c5f1D`, `FdcVerification` `0x906507E0B64bcD494Db73bd0459d1C667e14B933`
- `FtsoV2` `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d`, feed `XRP/USD`

---

## How it uses Flare

- **FAssets direct minting** — `executeDirectMinting` with an `IXRPPayment.Proof`,
  including the delay states, the executor fee, and the large-mint path.
- **The official `MintingTagManager`** — reservation, minting recipient, and the
  allowed-executor cooldown, used as designed rather than reimplemented.
- **FDC** — `XRPPayment` attestation type (0x08, not the older `Payment` 0x01),
  requested through `FdcHub` and collected from the DA layer.
- **FTSO** — `XRP/USD` for pricing a checkout in fiat terms.
- **ContractRegistry** — every address is resolved at runtime, so the same code
  runs on Coston2, Songbird, and Flare.

---

## What was newly built during the program

| Area | New work | Where |
|---|---|---|
| Limiter replay | The carry-over window, the large-mint bypass, the strict-`<` boundary, AMG/UBA conversion | `src/limiter.ts` |
| Live reader | Registry lookup, one-block-pinned snapshot, window-alignment assertion | `src/chain.ts` |
| Simulator | "when is this allowed?" and "what is the largest immediate mint?" | `src/cli.ts` |
| Delay-aware splitting | The large-mint rule is a cliff: one payment over the threshold takes a flat delay, the same total split below it can start landing immediately. Simulates both and reports the case where splitting is *worse*, because a large minting consumes no window quota | `src/plan.ts` |
| Outcome reader | `directMintingDelayState` polling that waits out `allowedAt` instead of guessing it | `src/chain.ts` |
| FDC round trip | prepareRequest → `requestAttestation` → voting round → DA layer proof, decoded to the struct the facet takes | `src/fdc.ts` |
| Executor bot | Delay treated as a delay: on-chain delay state beats local cache, proofs reused across attempts, no early retries, lost races retired instead of looped | `src/bot.ts` |
| Merchant checkout | The customer-side tagged XRPL payment | `src/pay.ts` |
| Dashboard | Raw getter vs real state, capacity, simulator, FTSO pricing, no build step | `dashboard/` |
| Parity harness | The verified `MintingRateLimiter.sol` copied byte for byte, run under Foundry across 17 scenarios; the TypeScript is checked against what it actually did, not against our reading of it | `parity/`, `test/parity.test.ts` |
| Render QA | Chromium + WebKit checks for console errors, horizontal overflow and `100dvh` drift — it found a masthead that pushed the page 19px wide on a phone and a hero canvas rendering through the opening paragraph | `qa/render.mjs` |
| Field notes | Every claim above traced to the verified on-chain source | `NOTES.md` |

---

## Honest scope

- **We lost the first race.** A competing executor proved and finalised our first
  tagged payment before our bot's proof landed; our call reverted
  `PaymentAlreadyConfirmed()` and the FDC fee we had paid was wasted. The merchant
  was still paid — the rail does not depend on us. We left the finding in rather
  than deleting it, because it is the clearest statement of why the predictor
  exists. The fix is the one the protocol already provides: set the tag's
  `allowedExecutor`, wait out the 600s cooldown, and the second payment was ours
  to finalise inside the exclusive window.
- **Window sizes are assumed, then checked.** They are fixed at initialisation and
  never exposed by a getter. We assume 3600 and 86400 and assert that the on-chain
  window start is aligned to them, so a change fails loudly instead of silently
  mispredicting.
- **Governance unblocking is read, not modelled.** `unblockDirectMintingsUntil`
  releases already-delayed mintings; the bot reads the resulting on-chain delay
  state rather than trying to predict a governance action.
- **Mainnet is read-only here.** The predictor and dashboard run against Flare
  mainnet, but every write in this submission was made on Coston2.
- **The bot is a single process with a JSON state file.** It is honest about what
  it has requested and what it has finished; it is not a highly-available service.

---

## Roadmap

1. **Executor as a service.** Multiple tags, competitive fee accounting, and a
   published record of which payments an executor finalised and how late.
2. **Merchant SDK.** Drop-in checkout that shows the customer a real completion
   estimate — "your FXRP arrives in about 40 minutes" — instead of a spinner.
3. **Execute the split, not just plan it.** `src/plan.ts` computes the schedule;
   the merchant still sends the payments by hand.
4. **Songbird and mainnet writes**, once the same rail is exercised there.
