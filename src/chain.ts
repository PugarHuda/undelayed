import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { flare, flareTestnet } from "viem/chains";
import {
  predict,
  ubaToAmg,
  amgToUba,
  undelayedCapacity,
  type Limits,
} from "./limiter.js";
import type { FeeConfig } from "./fees.js";

/** Flare's ContractRegistry, same address on every Flare network. */
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const REGISTRY_ABI = parseAbi([
  "function getContractAddressByName(string) view returns (address)",
]);

const ASSET_MANAGER_ABI = parseAbi([
  "function assetMintingGranularityUBA() view returns (uint256)",
  "function getDirectMintingHourlyLimitUBA() view returns (uint256)",
  "function getDirectMintingDailyLimitUBA() view returns (uint256)",
  "function getDirectMintingLargeMintingThresholdUBA() view returns (uint256)",
  "function getDirectMintingLargeMintingDelaySeconds() view returns (uint256)",
  "function getDirectMintingHourlyLimiterState() view returns (uint64,uint64)",
  "function getDirectMintingDailyLimiterState() view returns (uint64,uint64)",
  "function getDirectMintingExecutorFeeUBA() view returns (uint256)",
  "function getDirectMintingFeeBIPS() view returns (uint256)",
  "function getDirectMintingMinimumFeeUBA() view returns (uint256)",
  "function getDirectMintingOthersCanExecuteAfterSeconds() view returns (uint256)",
  "function directMintingPaymentAddress() view returns (string)",
  "function getMintingTagManager() view returns (address)",
]);

const FTSO_ABI = parseAbi([
  "function getFeedById(bytes21) view returns (uint256,int8,uint64)",
]);

/** FTSO v2 feed ids: category 01 (crypto) followed by the ASCII pair. */
const XRP_USD_FEED = "0x015852502f55534400000000000000000000000000" as const;
const FLR_USD_FEED = "0x01464c522f55534400000000000000000000000000" as const;

// The window sizes are fixed at initialization and never exposed by a getter,
// so they are named constants here. readLimits asserts the on-chain window
// start is aligned to them, which fails loudly if that ever stops being true.
const HOUR = 3600n;
const DAY = 86400n;

const songbird = defineChain({
  id: 19,
  name: "Songbird",
  nativeCurrency: { name: "Songbird", symbol: "SGB", decimals: 18 },
  rpcUrls: { default: { http: ["https://songbird-api.flare.network/ext/C/rpc"] } },
});

export const NETWORKS = {
  coston2: { chain: flareTestnet, rpc: "https://coston2-api.flare.network/ext/C/rpc" },
  flare: { chain: flare, rpc: "https://flare-api.flare.network/ext/C/rpc" },
  songbird: { chain: songbird, rpc: songbird.rpcUrls.default.http[0] },
} as const;

export type Network = keyof typeof NETWORKS;

export function client(network: Network) {
  const n = NETWORKS[network];
  return createPublicClient({ chain: n.chain, transport: http(n.rpc) });
}

export type Snapshot = Limits & {
  assetManager: `0x${string}`;
  mintingTagManager: `0x${string}`;
  granularityUba: bigint;
  executorFeeUba: bigint;
  /** What the facet takes out of a payment before the merchant is credited. */
  fees: FeeConfig;
  /**
   * How long a tag's `allowedExecutor` keeps exclusivity, measured from the
   * payment's own underlying timestamp — not from when the executor noticed it.
   */
  othersCanExecuteAfterSeconds: bigint;
  coreVaultAddress: string;
  now: bigint;
};

export async function readLimits(
  network: Network,
  fasset = "FXRP",
): Promise<Snapshot> {
  const pc = client(network);
  const assetManager = await pc.readContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getContractAddressByName",
    args: [`AssetManager${fasset}`],
  });
  // Pinned to one block so the limits and the limiter state are one snapshot.
  // No multicall3 here: viem has none configured for the Flare chains.
  const block = await pc.getBlock();
  const call = (functionName: string) =>
    pc.readContract({
      address: assetManager,
      abi: ASSET_MANAGER_ABI,
      functionName,
      blockNumber: block.number!,
    } as any);

  const [
    granularityUba,
    hourlyLimitUba,
    dailyLimitUba,
    largeThresholdUba,
    largeDelaySeconds,
    hourlyState,
    dailyState,
    executorFeeUba,
    coreVaultAddress,
    mintingTagManager,
    feeBips,
    minimumFeeUba,
    othersCanExecuteAfterSeconds,
  ] = (await Promise.all([
    call("assetMintingGranularityUBA"),
    call("getDirectMintingHourlyLimitUBA"),
    call("getDirectMintingDailyLimitUBA"),
    call("getDirectMintingLargeMintingThresholdUBA"),
    call("getDirectMintingLargeMintingDelaySeconds"),
    call("getDirectMintingHourlyLimiterState"),
    call("getDirectMintingDailyLimiterState"),
    call("getDirectMintingExecutorFeeUBA"),
    call("directMintingPaymentAddress"),
    call("getMintingTagManager"),
    call("getDirectMintingFeeBIPS"),
    call("getDirectMintingMinimumFeeUBA"),
    call("getDirectMintingOthersCanExecuteAfterSeconds"),
  ])) as any[];

  // The limiter state getters return raw AMG while the limit getters convert to
  // UBA. Mixing them is a units bug whenever granularity != 1.
  const limits: Limits = {
    hourly: {
      windowSizeSeconds: HOUR,
      maxPerWindow: ubaToAmg(hourlyLimitUba, granularityUba),
      windowStart: BigInt(hourlyState[0]),
      minted: BigInt(hourlyState[1]),
    },
    daily: {
      windowSizeSeconds: DAY,
      maxPerWindow: ubaToAmg(dailyLimitUba, granularityUba),
      windowStart: BigInt(dailyState[0]),
      minted: BigInt(dailyState[1]),
    },
    largeThresholdAmg: ubaToAmg(largeThresholdUba, granularityUba),
    largeDelaySeconds,
  };
  for (const l of [limits.hourly, limits.daily]) {
    if (l.windowStart % l.windowSizeSeconds !== 0n) {
      throw new Error(
        `window start ${l.windowStart} is not aligned to ${l.windowSizeSeconds}s — window size assumption is wrong`,
      );
    }
  }

  return {
    ...limits,
    assetManager,
    mintingTagManager,
    granularityUba,
    executorFeeUba,
    fees: { feeBips, minimumFeeUba, executorFeeUba },
    othersCanExecuteAfterSeconds,
    coreVaultAddress,
    now: block.timestamp,
  };
}

/**
 * One FTSO feed, as a plain number. Returns null when it is not reachable — a
 * checkout that cannot price is a checkout that must not guess.
 */
async function feedUsd(network: Network, feedId: `0x${string}`): Promise<number | null> {
  const pc = client(network);
  try {
    const ftso = await pc.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: ["FtsoV2"],
    });
    const [value, decimals] = (await pc.readContract({
      address: ftso,
      abi: FTSO_ABI,
      functionName: "getFeedById",
      args: [feedId],
    })) as [bigint, number, bigint];
    return Number(value) / 10 ** Number(decimals);
  } catch {
    return null;
  }
}

export const xrpUsd = (network: Network) => feedUsd(network, XRP_USD_FEED);

/**
 * FLR/USD. The executor pays gas in the native token, so pricing its costs
 * needs this — and on Coston2 the native token is worthless, which would make
 * any margin look infinite. The mainnet feed is the honest one to quote.
 */
export const flrUsd = (network: Network) => feedUsd(network, FLR_USD_FEED);

/** "If I mint X XRP right now, when is execution allowed?" */
export function ask(snap: Snapshot, amountUba: bigint, now = snap.now) {
  const amountAmg = ubaToAmg(amountUba, snap.granularityUba);
  const p = predict(snap, amountAmg, now);
  return { ...p, waitSeconds: p.allowedAt > now ? p.allowedAt - now : 0n };
}

export const capacityUba = (snap: Snapshot, now = snap.now) =>
  amgToUba(undelayedCapacity(snap, now), snap.granularityUba);

const DELAY_STATE_ABI = parseAbi([
  "function directMintingDelayState(bytes32) view returns (uint8,uint256,uint256)",
]);

const DELAY_STATES = ["not-delayed", "delayed", "released"] as const;
export type DelayState = (typeof DELAY_STATES)[number];

/**
 * What the chain says about one payment. `not-delayed` means either "never seen"
 * or "went straight through" — the two are indistinguishable here, which is why
 * an executor also has to look at whether the payment was confirmed.
 */
export async function outcome(
  network: Network,
  assetManager: `0x${string}`,
  transactionId: `0x${string}`,
) {
  const [state, allowedAt, startedAt] = (await client(network).readContract({
    address: assetManager,
    abi: DELAY_STATE_ABI,
    functionName: "directMintingDelayState",
    args: [transactionId],
  })) as [number, bigint, bigint];
  return { state: DELAY_STATES[state] ?? "not-delayed", allowedAt, startedAt };
}

/**
 * Blocks until a delayed minting is allowed to execute, which is the thing an
 * executor must not guess at: calling before `allowedAt` reverts
 * DirectMintingStillDelayed and the FDC proof is spent for nothing.
 */
export async function waitForOutcome(
  network: Network,
  assetManager: `0x${string}`,
  transactionId: `0x${string}`,
  { pollMs = 30_000, maxWaitSeconds = 86_400 } = {},
) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  for (;;) {
    const o = await outcome(network, assetManager, transactionId);
    if (o.state !== "delayed") return o;
    const now = (await client(network).getBlock()).timestamp;
    if (now >= o.allowedAt) return { ...o, state: "released" as DelayState };
    if (Date.now() > deadline) throw new Error(`still delayed until ${o.allowedAt}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
