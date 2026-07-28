# parity

The real thing, so the replay can be checked against it instead of against
someone's reading of it.

`src/` holds `MintingRateLimiter.sol` and `MathUtils.sol` exactly as they are
published on the Coston2 explorer — **not edited**. The nested directory layout
exists only so the library's own relative import resolves; `lib/openzeppelin/`
holds the one OpenZeppelin file it imports, remapped in `foundry.toml`.

`test/Vectors.t.sol` runs the library and writes what it did to
`out-vectors/vectors.json` — **217 vectors**, committed, so `npm test` checks the
TypeScript against them without needing forge.

17 of them are scenarios chosen by hand: fresh windows, landing exactly on the
limit, five times the limit at once, quiet periods where several windows elapse,
limits that do not divide evenly, zero. The weakness of hand-chosen cases is that
they only cover cases someone thought of, so the other 200 come from five
deterministic random walks — fixed seeds, so a failure reproduces and the
committed vectors stay reviewable. Not forge fuzzing: fuzz runs reset state
between calls, and the carry-over rule only shows up when state carries.

The amount scale is drawn per step rather than flat. A flat draw across 0..3x the
limit looked thorough and was not — debt carries, so one overspend delays every
later step and the not-delayed branch stops being exercised. It sat at 203
delayed out of 217. Bucketed draws (dust / up to the limit / within a unit of the
edge / several times over) give 168 delayed and 49 not.

## Does the differential test actually bite?

Seven mutations of `src/limiter.ts`, six caught:

| mutation | |
|---|---|
| strict `<` becomes `<=` | caught |
| `allowedAt` floors the ratio, not the product | caught |
| `allowedAt` uses `minted` from before the amount | caught |
| the carry-over debt clamp is removed | caught |
| the amount is added before the window advances | caught |
| `windowStart` is not advanced | caught |
| `elapsed` off by one | caught |
| `now <= windowStart` becomes `now <` | **survives** |

The survivor is equivalent, not a gap: at `now == windowStart` the `<` version
falls through to `elapsed == 0` and returns the limiter unchanged anyway. Both
branches produce the same state, so no vector can separate them.

```
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
npm run parity        # from the repo root — regenerates the vectors
npm test              # checks src/limiter.ts against them
```

If Flare changes the limiter, regenerating the vectors is what tells you, rather
than the product quietly mispredicting.
