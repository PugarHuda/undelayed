# Direct minting, as it actually behaves

Everything below is read off the verified `AssetManager` diamond on Coston2, not
off the docs. Sources: `DirectMintingFacet.sol`, `DirectMintingSettingsFacet.sol`,
`library/data/MintingRateLimiter.sol`.

## Addresses

| | Coston2 | Flare |
|---|---|---|
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` | `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8` |
| MintingTagManager | `0x094511737909b626391106bBc21B25feb2D67B96` | — |
| Core vault XRPL | `rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p` | `rfkXSaCZKTg1EZzec2rLDyrWHxRVJdtVXj` |
| hourly / daily limit | 100k / 500k XRP | 4M / 40M XRP |
| large threshold / delay | 100k XRP / 1h | 4M XRP / 2h |

Both resolve through the ContractRegistry at
`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same address on every Flare chain).

## Four things that are not obvious

1. **It is not a tumbling window.** `_processElapsedWindows` subtracts one whole
   limit per elapsed window (`subOrZero`) instead of resetting. Overspend carries
   forward, and `allowedAt = windowStart + windowSize * minted / max`. A mint of
   5x the limit waits ~5 windows, not "until the next hour".

2. **A large minting skips both limiters.** `amount >= largeThreshold` is delayed
   `now + largeDelaySeconds` and never calls `recordMinting` — it consumes no
   hourly or daily quota at all.

3. **The state getters return AMG, the limit getters return UBA.**
   `getDirectMintingHourlyLimiterState()` reads the raw struct;
   `getDirectMintingHourlyLimitUBA()` goes through `convertAmgToUBA`. Comparing
   them directly is a units bug for any asset whose
   `assetMintingGranularityUBA() != 1`. It is 1 for FXRP today, so the bug is
   silent until it isn't.

4. **Retrying early reverts.** The first attempt records the delay and returns
   `msg.value`; a second attempt before `allowedAt` reverts
   `DirectMintingStillDelayed(allowedAt)`. An executor that guesses burns gas and
   an FDC proof for nothing.

The amount is recorded into both limiters even when the minting is delayed, and
the delayed entry captures recipient/executor at delay time, so transferring the
tag afterwards does not redirect it.

## The FDC round trip, as measured

Proven end to end on Coston2 against a real core-vault payment
(`7507EF72…61D3`, 10.2 XRP): request accepted, attestation requested on-chain
(`0x93343584…1ae1`, fee **1000 wei**, voting round 1407655, 90s rounds), proof
pulled off the DA layer, response decoded.

- Attestation type is **`XRPPayment` (0x08)**, not the older `Payment` (0x01) —
  the old verifier route 400s.
- Verifier: `https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment/prepareRequest`
- DA layer: `https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw`
  (the `/api/v0/` path is gone).
- Public testnet API key `00000000-0000-0000-0000-000000000000` still works.
- FdcHub `0x48aC463d7975828989331F4De43341627b9c5f1D`,
  FdcVerification `0x906507E0B64bcD494Db73bd0459d1C667e14B933`.
- `verifyProofOwnership` allows `proofOwner == address(0) || == msg.sender`, so
  request with **zero** — a delayed minting must stay executable by whoever
  shows up an hour later.

## How a payment finds its recipient

`_decodeTarget`: a registered destination tag wins and the memo is ignored;
otherwise a 32-byte memo holding a `DIRECT_MINTING` payment reference is decoded
into the recipient address. A registered tag also carries its `allowedExecutor`,
and `othersCanExecuteAfterSeconds` (600s on Coston2) is how long that
exclusivity lasts before anyone may execute.

This is the whole of TagRail: reserve a tag, point it at the merchant, point its
executor at the bot. No new Solidity.

### Proven on Coston2

Tag **205** reserved in the official manager (`0xcf83447c…f6da`, 100 C2FLR),
recipient set to the merchant address. One ordinary XRPL payment of 5 XRP with
`DestinationTag: 205` (`DCD6E28B…0A47`) produced **4.8 FTestXRP** at the merchant
address (`0x4eb2ec845191`) about thirty seconds later. The 0.2 XRP difference is
the system minting fee plus the 0.1 XRP executor fee.

**We lost the race.** A competing executor proved and executed the payment before
our bot's proof landed, so our simulation reverted `PaymentAlreadyConfirmed()`
(`0x18dce79f`) and the FDC fee we paid was wasted. The merchant was still paid —
the rail is permissionless and does not depend on us. This is exactly the
economics the predictor exists for: an executor that guesses wrong about timing
pays for proofs it can never use.

**Then we won it.** `setAllowedExecutor(205, bot)` (`0x4ed08822…2e0b`), 600s
cooldown, and a second 7 XRP payment (`6465EFFF…C07B`) was ours to finalise
inside the exclusive window: `0x595a419c…5e0f` minted **0.1 FXRP system fee,
6.8 to the merchant, 0.1 executor fee to the bot** — 7 XRP split exactly as
`_computeFees` computes it.

The exclusive window is `othersCanExecuteAfterSeconds` (600s on Coston2) measured
from the *payment's* underlying timestamp, not from when you noticed it. An
executor that takes longer than that to get a proof has no exclusivity left.

## Window sizes

Never exposed by a getter — fixed at `initialize`. We assume 3600 and 86400 and
assert that the on-chain `windowStartTimestamp` is aligned to them, which fails
loudly rather than silently mispredicting if that ever changes.
