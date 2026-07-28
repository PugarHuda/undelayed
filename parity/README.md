# parity

The real thing, so the replay can be checked against it instead of against
someone's reading of it.

`src/` holds `MintingRateLimiter.sol` and `MathUtils.sol` exactly as they are
published on the Coston2 explorer — **not edited**. The nested directory layout
exists only so the library's own relative import resolves; `lib/openzeppelin/`
holds the one OpenZeppelin file it imports, remapped in `foundry.toml`.

`test/Vectors.t.sol` runs the library through 17 scenarios — fresh windows,
landing exactly on the limit, five times the limit at once, quiet periods where
several windows elapse, limits that do not divide evenly, zero — and writes what
it did to `out-vectors/vectors.json`. Those vectors are committed, so
`npm test` checks the TypeScript against them without needing forge.

```
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
npm run parity        # from the repo root — regenerates the vectors
npm test              # checks src/limiter.ts against them
```

If Flare changes the limiter, regenerating the vectors is what tells you, rather
than the product quietly mispredicting.
