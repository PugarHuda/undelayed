# DoraHacks form — Undelayed (Bounty 1)

Paste-ready answers for the ten fields the program asks for.

**1. Project name**
Undelayed (with TagRail)

**2. Bounty**
Interoperable Assets (Bounty 1)

**3. Short product description**
A merchant rail for FXRP direct minting, plus the only tool that tells you when a
direct minting will actually execute. When FAssets direct minting hits a rate
limit it does not fail — it goes quiet and executes later. Undelayed replays the
limiter off-chain exactly as the contract runs it and answers "if I mint X XRP
now, when is execution allowed?". TagRail is the merchant half: reserve a tag in
Flare's official MintingTagManager, show the core vault address and that tag at
checkout, and an executor bot finalises the payment for the executor fee.

**4. Target user**
Merchants accepting XRP for goods priced on Flare, and the executors who race to
finalise those payments.

**5. Demo link or video**
_(record before submitting — see DEMO_SCRIPT.md)_

**6. GitHub repo**
_(publish before submitting)_

**7. How it uses Flare**
FAssets direct minting (`executeDirectMinting` with `IXRPPayment.Proof`, delay
states, executor fee, large-mint path); the official `MintingTagManager`
(reservation, minting recipient, allowed-executor cooldown); FDC (`XRPPayment`
attestation type 0x08 via `FdcHub`, proof collected from the DA layer); FTSO
(`XRP/USD` for checkout pricing); ContractRegistry for every address, so the same
code runs on Coston2, Songbird and Flare.

**8. What was newly built during the program**
All of it. Nothing ported. The limiter replay, the live reader, the simulator,
the FDC round trip, the executor bot, the customer-side checkout payment, and the
dashboard were written during Summer Signal against FAssets v1.3 on Coston2. The
behaviour they encode was read off the verified `AssetManager` diamond, not out
of documentation — the carry-over window, the large-mint bypass and the AMG/UBA
getter mismatch are all documented in `NOTES.md` with their sources.

**Deliberately not built:** a minting tag manager. Flare already ships one, it is
live on Coston2 with 185 tags reserved, and duplicating protocol infrastructure
is not a product. TagRail adds no contracts of its own.

**9. Deployment details**
No contracts deployed — this rail uses Flare's own. Resolved through the
ContractRegistry `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`:
- AssetManagerFXRP — Coston2 `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`, Flare `0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8`
- MintingTagManager — Coston2 `0x094511737909b626391106bBc21B25feb2D67B96`
- FdcHub `0x48aC463d7975828989331F4De43341627b9c5f1D`, FtsoV2 `0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d`

On-chain evidence on Coston2:
- tag 205 reserved — `0xcf83447c87cce1b9d27dd12b9046b27fd9c1151efc696725bd5349503a68f6da`
- customer pays 5 XRP with tag 205 — XRPL `DCD6E28B7218B454391505B0321E351CAB839BE6910025FCBE550E1680600A47`
- merchant receives 4.8 FTestXRP — `0x4eb2ec845191…`
- FDC attestation requested — `0x933435849b9313114482febb29600cd91c5765b8848d8919daf61b730cd61ae1`

**10. Roadmap**
1. Executor as a service — multiple tags, fee accounting, a public record of what
   each executor finalised and how late.
2. Merchant SDK — a checkout that shows a real completion estimate instead of a
   spinner.
3. Delay-aware order splitting under the carry-over rule.
4. Songbird and Flare mainnet writes.
