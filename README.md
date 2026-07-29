# Undelayed

**When a FAssets direct minting hits a rate limit it does not fail. It goes
quiet and executes later.** This tells you when.

Plus **TagRail**: a merchant checkout on Flare's own minting tags, and an
executor bot that survives the delay rules.

Live dashboard: **https://undelayed.vercel.app**

```
npm install
npm test                              # 53 cases, including parity with the real contract
npm run probe -- coston2 120000       # if I mint 120k XRP now, what happens?
npm run probe -- flare 1000           # same question on mainnet
```

## How we know the replay is right

`parity/` holds the verified Coston2 `MintingRateLimiter.sol`, copied byte for
byte — the directory layout exists only so its own import paths resolve. A
Foundry test runs it through 17 scenarios and writes down what it did;
`test/parity.test.ts` replays the same steps in TypeScript and demands identical
output: delayed flag, `allowedAt`, and both pieces of post-state.

```
npm run parity     # regenerate the vectors from the Solidity (needs forge)
npm test           # check the TypeScript against them
```

217 vectors: 17 scenarios chosen by hand, 200 from deterministic random walks,
because hand-chosen cases only cover cases someone thought of. Seven mutations of
`limiter.ts` were tried against them and six died; the survivor is provably
equivalent. Details and the mutation table are in `parity/README.md`. If Flare
changes the limiter, this breaks instead of the product quietly mispredicting.

## What the merchant actually receives

A payment does not arrive intact, and the gap is not a flat percentage:

```
npm run pay -- 205 --usd 25 --quote

  invoice     $25 at 1.062743 USD/XRP = 23.524032 XRP to the merchant
  send        23.724032 XRP
   ├ system fee   0.1  (the minimum, not the percentage)
   ├ executor fee 0.1
   └ merchant     23.524032 FXRP
  execution   allowed immediately
```

`_computeFees` takes `max(0.25% , 0.1 XRP)` for the system and then the executor
fee out of what is left, so below 40 XRP on Coston2 the system fee is flat and
above it is a percentage. A merchant who invoices the sticker price is underpaid
on every sale. `src/fees.ts` inverts the formula and gives the smallest payment
that nets the price — checked by a test that also proves one drop less is not
enough.

Splitting changes the answer. Every piece is charged separately, so grossing up
for one payment and *then* splitting leaves the merchant short by exactly the
fees nobody counted — `invoiceSplit` grosses up against the pieces that will
actually be sent.

## Is running an executor worth it?

```
npm run bot -- --report

  economics — gas 650 gwei, FLR $0.0062, XRP $1.0717
  per win   +$0.1072 fee  -$0.0018 gas  = $0.1054
  per loss  -$0.0003  (the attestation, paid before you know)
  smallest paying payment 0.102 XRP
  break-even win rate 0.3%
```

The executor fee is a prize in a race, not a salary: an executor that requests a
proof and loses has paid for a call it can never make. The gas figures are the
ones our own transactions burned (356,375 to execute, 82,947 to request), priced
at the live gas price and FTSO FLR/USD. At today's prices the rail clears its
costs by a wide margin, and the binding constraint is not gas — it is the
0.1 XRP minimum system fee, below which there is no executor fee left to earn.

```
  hourly limit   100,000 XRP   on-chain reads         1 used   actually  0 used   <- window rolled 4h 1m ago
  daily  limit   500,000 XRP   on-chain reads 16,285.658 used   actually  0 used   <- window rolled 26h 1m ago

  largest mint that executes immediately: 99,999.999999 XRP
  large-mint threshold 100,000 XRP -> always delayed 1h, and never consumes window quota

  minting 120,000 XRP now: DELAYED by large until 02:59:26 UTC (wait 1h)
```

## Splitting

The large-mint rule is a cliff, not a slope. 100,001 XRP as one payment is a
large minting: flat one-hour delay. Split just under the threshold and the first
99,999.999999 lands immediately.

It does not always win, and the tool says so:

```
  minting 250,000 XRP now: DELAYED by large until 17:28:24 UTC (wait 1h)

  split into 3 payments instead:
     1.  99,999.999999 XRP  immediately
     2.  99,999.999999 XRP  at 17:59:59 UTC
     3.  50,000.000002 XRP  at 18:30:00 UTC
  but the tail then lands 1h 1m later than one payment — splitting is not free here.
```

A large minting consumes no window quota at all, so forcing it through the
limiter can settle the tail later than simply waiting out the flat delay.

## Why the raw getters are not enough

`getDirectMintingHourlyLimiterState()` returns the *stored* window. Between
writes it goes stale, and it is not a tumbling window either — each elapsed
window subtracts one whole limit instead of resetting, so overspend carries
forward. A mint at or above the large-mint threshold skips both limiters
entirely. `NOTES.md` traces every one of these to the verified on-chain source.

## The pieces

| | |
|---|---|
| `src/limiter.ts` | The replay. Pure, no chain, fully tested. |
| `src/plan.ts` | Delay-aware splitting: is it faster as one payment or several? |
| `src/chain.ts` | Live snapshot, pinned to one block, addresses via the ContractRegistry. |
| `src/cli.ts` | `npm run probe` — capacity and the simulator. |
| `src/fdc.ts` | The FDC round trip: prepare, request, wait for the round, pull the proof. |
| `src/prove.ts` | `npm run prove -- <xrplTxHash>` — dry run one payment end to end. |
| `src/fees.ts` | What the merchant is actually credited, and what to invoice to net a price — including when the payment will be split. |
| `src/decide.ts` | What the executor should do about one payment, as a pure function: execute, wait, or skip. Extracted so the part that spends money can be tested. |
| `src/economics.ts` | Whether running an executor pays. Measured gas, live prices, and the win rate it takes to break even. |
| `src/bot.ts` | `npm run bot` — the executor. `--report` for its own books and the economics. |
| `src/pay.ts` | `npm run pay -- <tag> [xrp] [--usd n] [--net xrp] [--split] [--quote]` — the customer side. |
| `dashboard/` | One file, no build step. `npm run build:web` regenerates `limiter.js`, `plan.js` and `fees.js` from the same source the SDK uses, so the page cannot drift from the tests. |
| `parity/` | The real Solidity limiter, and the harness that proves we match it. |
| `qa/flows.mjs` | `npm run qa:flows` — drives the page: prices a basket, splits a mint, then feeds every input garbage, negatives, zero, empty, 1e999. A form that keeps its last good answer for a question nobody asked is the bug it exists to catch. |
| `qa/flows-landing.mjs` | The landing page's sealed-bid demo, which nothing exercised before: five bids sealed, one winner revealed, four still sealed, and the clearing price pinned to the runner-up's. A first-price mutation renders identically and this is what catches it. |
| `qa/flows-desk.mjs` | The same for the Buta desk, where the honest-offline state is the happy path. |
| `qa/render.mjs` | `npm run qa` — Chromium and WebKit, failing on console errors, horizontal overflow, a `100dvh` that disagrees with the viewport, **text painted over by something opaque**, and **panels still showing their loading text**. It runs a deliberately broken fixture first and fails if that page comes back clean. |

## Running the executor

```
PRIVATE_KEY=0x… npm run bot -- --tags 205
```

It watches the core vault on XRPL for payments carrying tags it serves, proves
them with the FDC, and calls `executeDirectMinting` for the executor fee. A
delayed minting is left alone until `allowedAt` — retrying early reverts
`DirectMintingStillDelayed` and wastes the proof. A payment another executor
already finalised is retired, not retried.

## A merchant checkout, end to end

```
cast send <MintingTagManager> "reserve()" --value 100ether     # returns your tag
cast send <MintingTagManager> "setMintingRecipient(uint256,address)" <tag> <merchant>
npm run pay -- <tag> 5                                          # what the customer does
```

Nothing above deploys a contract. Flare already ships `MintingTagManager`; this
uses it.

Built for Flare Summer Signal. See `SUBMISSION.md`.
