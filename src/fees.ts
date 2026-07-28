/**
 * What the merchant actually receives, and what to put on the invoice.
 *
 * A tagged payment does not arrive intact. `DirectMintingFacet._computeFees`
 * takes a system fee and an executor fee out of it before the FXRP is minted,
 * so a merchant who prices a $25 item and asks for $25 of XRP is paid less than
 * $25 every single time. The gap is not proportional either: the system fee has
 * a floor, so on small baskets it is a flat charge and on large ones it is a
 * percentage.
 *
 * Mirror of, from the verified Coston2 AssetManager:
 *   contracts/assetManager/facets/DirectMintingFacet.sol :: _computeFees
 *
 *   relativeFee  = mulBips(received, feeBIPS)          // floors
 *   mintingFee   = min(max(relativeFee, minimumFee), received)
 *   executorFee  = min(executorFee, received - mintingFee)   // system fee wins
 *   merchant gets received - mintingFee - executorFee
 *
 * Everything is UBA (drops for XRP), the unit the fee getters return.
 */

export type FeeConfig = {
  /** getDirectMintingFeeBIPS() — 25 on Coston2, 10 on Flare. */
  feeBips: bigint;
  /** getDirectMintingMinimumFeeUBA() — 0.1 XRP on both. */
  minimumFeeUba: bigint;
  /** getDirectMintingExecutorFeeUBA() — 0.1 XRP on Coston2, 0.2 on Flare. */
  executorFeeUba: bigint;
};

export type Breakdown = {
  /** What the customer sends to the core vault. */
  paidUba: bigint;
  mintingFeeUba: bigint;
  executorFeeUba: bigint;
  /** What is minted to the merchant. */
  netUba: bigint;
  /**
   * `_paymentTooSmall`: the payment is below the minimum fee. The facet does not
   * mint for these — a checkout that lets one through has taken the customer's
   * XRP for nothing.
   */
  tooSmall: boolean;
};

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

const BIPS = 10_000n;

/** Forward direction: the customer sends this much, the merchant gets what? */
export function fees(paidUba: bigint, cfg: FeeConfig): Breakdown {
  const relative = (paidUba * cfg.feeBips) / BIPS; // mulBips floors
  const mintingFeeUba = min(max(relative, cfg.minimumFeeUba), paidUba);
  const executorFeeUba = min(cfg.executorFeeUba, paidUba - mintingFeeUba);
  return {
    paidUba,
    mintingFeeUba,
    executorFeeUba,
    netUba: paidUba - mintingFeeUba - executorFeeUba,
    tooSmall: paidUba < cfg.minimumFeeUba,
  };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Inverse: the merchant wants to be credited `wantNetUba`, so what goes on the
 * invoice? Returns the smallest payment that nets at least that much.
 *
 * Two closed forms, one per branch of the max() — flat while the minimum fee
 * dominates, grossed-up once the percentage overtakes it — then a short walk
 * down, because mulBips floors and the closed form can overshoot by a drop.
 */
export function invoice(wantNetUba: bigint, cfg: FeeConfig): Breakdown {
  if (cfg.feeBips >= BIPS) {
    // The system fee would eat the whole payment; no invoice can settle.
    throw new Error(`feeBips ${cfg.feeBips} takes the entire payment`);
  }
  if (wantNetUba <= 0n) return fees(max(cfg.minimumFeeUba, 0n), cfg);

  const flat = wantNetUba + cfg.minimumFeeUba + cfg.executorFeeUba;
  const grossed = ceilDiv((wantNetUba + cfg.executorFeeUba) * BIPS, BIPS - cfg.feeBips);

  let paid = max(flat, grossed);
  // ponytail: linear walk, not a binary search — net() is monotone in paid and
  // both closed forms are exact up to the floor, so this runs twice at most.
  while (paid > 1n && fees(paid - 1n, cfg).netUba >= wantNetUba) paid -= 1n;
  return fees(paid, cfg);
}

/**
 * A price in USD, at an FTSO XRP/USD reading, as an XRP amount in UBA.
 * Rounds up: rounding down invoices the customer for less than the sticker.
 */
export function usdToUba(usd: number, xrpUsd: number, granularityUba = 1n): bigint {
  if (!(xrpUsd > 0)) throw new Error(`XRP/USD price ${xrpUsd} is not usable`);
  const drops = ceilDiv(BigInt(Math.round(usd * 1e6)) * 1_000_000n, BigInt(Math.round(xrpUsd * 1e6)));
  // round up to a whole AMG, since anything finer cannot be minted
  return granularityUba > 1n ? ceilDiv(drops, granularityUba) * granularityUba : drops;
}
