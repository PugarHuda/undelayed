/**
 * Is running an executor worth it?
 *
 * The rail is permissionless, which means the executor fee is not a salary — it
 * is a prize in a race, and the losers pay to enter. An executor that requests a
 * proof and loses has spent gas and an attestation fee on a call it can never
 * make. That cost is real and nobody's documentation mentions it.
 *
 * Two questions this answers, neither of which the raw getters can:
 *
 *   1. Below what payment size does a *win* not even cover its own gas?
 *   2. At what win rate does the whole operation break even?
 *
 * Gas figures are measured, not assumed — see COSTON2_MEASURED below.
 */
import { fees, type FeeConfig } from "./fees.js";

export type ExecutorCosts = {
  /** Gas for executeDirectMinting, including the FDC proof in calldata. */
  executeGas: bigint;
  /** Gas for the FdcHub attestation request. Paid win or lose. */
  requestGas: bigint;
  gasPriceWei: bigint;
  /** FdcHub's own fee, in wei. */
  attestationFeeWei: bigint;
  /** Native token price — C2FLR is worthless, so a demo should pass FLR's. */
  nativeUsd: number;
  xrpUsd: number;
};

/**
 * Read off our own transactions on Coston2, not estimated:
 *   executeDirectMinting  0x595a419c…5e0f   356,375 gas
 *   requestAttestation    0x93343584…1ae1    82,947 gas
 * both at the 650 gwei the network was charging.
 */
export const COSTON2_MEASURED = {
  executeGas: 356_375n,
  requestGas: 82_947n,
  gasPriceWei: 650_000_000_000n,
  attestationFeeWei: 1000n,
} as const;

const WEI = 1e18;
const UBA = 1e6;

export type Attempt = {
  /** Executor fee if this attempt wins, in UBA. */
  revenueUba: bigint;
  revenueUsd: number;
  /** What a winning attempt costs: request + execute. */
  winCostUsd: number;
  /** What a losing attempt costs: the request only — the execute never lands. */
  lossCostUsd: number;
  /** Profit on a win. Negative means winning is not worth the gas. */
  winMarginUsd: number;
};

const usdOf = (wei: bigint, nativeUsd: number) => (Number(wei) / WEI) * nativeUsd;

export function attempt(paymentUba: bigint, cfg: FeeConfig, c: ExecutorCosts): Attempt {
  // Not the setting: on a payment squeezed between the two fees the executor is
  // the one who goes short, so revenue has to come from the split.
  const revenueUba = fees(paymentUba, cfg).executorFeeUba;
  const requestWei = c.requestGas * c.gasPriceWei + c.attestationFeeWei;
  const executeWei = c.executeGas * c.gasPriceWei;

  const revenueUsd = (Number(revenueUba) / UBA) * c.xrpUsd;
  const lossCostUsd = usdOf(requestWei, c.nativeUsd);
  const winCostUsd = usdOf(requestWei + executeWei, c.nativeUsd);
  return { revenueUba, revenueUsd, winCostUsd, lossCostUsd, winMarginUsd: revenueUsd - winCostUsd };
}

/**
 * Smallest payment whose executor fee covers the gas of winning it. Below this
 * an executor is paying to serve the merchant.
 *
 * Returns null when no payment ever covers it — the executor fee is capped, so
 * if the cap does not pay for the gas, nothing does.
 */
export function payingPayment(cfg: FeeConfig, c: ExecutorCosts): bigint | null {
  // Above minimumFee + executorFee the fee is at its cap, and revenue stops
  // growing. If the cap is not enough, no size helps.
  const capped = cfg.minimumFeeUba + cfg.executorFeeUba;
  if (attempt(capped, cfg, c).winMarginUsd < 0) return null;

  // Revenue is monotone in the payment, so walk the only interesting range:
  // between the minimum fee (below which nothing mints) and the cap.
  for (let paid = cfg.minimumFeeUba; paid <= capped; paid += 1000n) {
    if (attempt(paid, cfg, c).winMarginUsd >= 0) return paid;
  }
  return capped;
}

/**
 * The win rate at which an executor breaks even on a payment of this size.
 *
 *   E = w * (revenue - winCost) - (1 - w) * lossCost = 0
 *   w = lossCost / (revenue - winCost + lossCost)
 *
 * Returns null when winning is itself unprofitable — then no win rate saves it.
 */
export function breakEvenWinRate(paymentUba: bigint, cfg: FeeConfig, c: ExecutorCosts): number | null {
  const a = attempt(paymentUba, cfg, c);
  if (a.winMarginUsd <= 0) return null;
  return a.lossCostUsd / (a.winMarginUsd + a.lossCostUsd);
}
