# Undelayed

**When a FAssets direct minting hits a rate limit it does not fail. It goes
quiet and executes later.** This tells you when.

Plus **TagRail**: a merchant checkout on Flare's own minting tags, and an
executor bot that survives the delay rules.

```
npm install
npm test                              # 15 cases, including parity with the real contract
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

Changing `<` to `<=` in one comparison in `limiter.ts` fails it immediately. If
Flare changes the limiter, this breaks instead of the product quietly
mispredicting.

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
| `src/bot.ts` | `npm run bot` — the executor. |
| `src/pay.ts` | `npm run pay -- <tag> [xrp]` — the customer side of a checkout. |
| `dashboard/` | One file, no build step. `npm run build:web` regenerates `limiter.js` and `plan.js` from the same source the SDK uses, so the page cannot drift from the tests. |
| `parity/` | The real Solidity limiter, and the harness that proves we match it. |
| `qa/render.mjs` | `npm run qa` — renders the page in Chromium and WebKit and fails on console errors, horizontal overflow, or a `100dvh` that disagrees with the viewport. |

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
