/**
 * The FDC round-trip an executor has to do before it can mint anything:
 *   verifier prepareRequest -> FdcHub.requestAttestation -> wait for the voting
 *   round -> pull the Merkle proof off the DA layer.
 *
 * Attestation type is XRPPayment (0x08), not the older Payment (0x01) — the
 * direct minting facet takes IXRPPayment.Proof, and the old type's verifier
 * route 400s.
 */
import {
  createWalletClient,
  http,
  parseAbi,
  decodeAbiParameters,
  parseAbiParameters,
  toHex,
  padHex,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { client, NETWORKS, type Network } from "./chain.js";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

export const FDC = {
  coston2: {
    verifier: "https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment/prepareRequest",
    da: "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw",
    sourceId: "testXRP",
  },
  flare: {
    verifier: "https://fdc-verifiers-mainnet.flare.network/verifier/xrp/XRPPayment/prepareRequest",
    da: "https://flr-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw",
    sourceId: "XRP",
  },
} as const;

// The public testnet key Flare hands out in the docs. Override for mainnet.
const API_KEY = process.env.FDC_API_KEY ?? "00000000-0000-0000-0000-000000000000";

const name32 = (s: string) => padHex(stringToHex(s), { size: 32, dir: "right" });

const RESPONSE_ABI = parseAbiParameters(
  "(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
    " (bytes32 transactionId, address proofOwner) requestBody," +
    " (uint64 blockNumber, uint64 blockTimestamp, string sourceAddress, bytes32 sourceAddressHash," +
    "  bytes32 receivingAddressHash, bytes32 intendedReceivingAddressHash, int256 spentAmount," +
    "  int256 intendedSpentAmount, int256 receivedAmount, int256 intendedReceivedAmount," +
    "  bool hasMemoData, bytes firstMemoData, bool hasDestinationTag, uint256 destinationTag," +
    "  uint8 status) responseBody)",
);

/**
 * proofOwner defaults to the zero address on purpose: a delayed minting has to
 * be executable later by whoever shows up, and verifyProofOwnership only allows
 * address(0) or msg.sender.
 */
export async function prepareRequest(
  network: Network,
  transactionId: `0x${string}`,
  proofOwner: `0x${string}` = "0x0000000000000000000000000000000000000000",
) {
  const cfg = FDC[network as keyof typeof FDC];
  const res = await fetch(cfg.verifier, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
    body: JSON.stringify({
      attestationType: name32("XRPPayment"),
      sourceId: name32(cfg.sourceId),
      requestBody: { transactionId, proofOwner },
    }),
  });
  const body = (await res.json()) as { status: string; abiEncodedRequest?: `0x${string}` };
  if (body.status !== "VALID" || !body.abiEncodedRequest) {
    throw new Error(`verifier rejected the request: ${body.status}`);
  }
  return body.abiEncodedRequest;
}

const FDC_HUB_ABI = parseAbi(["function requestAttestation(bytes) payable"]);
const FEE_ABI = parseAbi(["function getRequestFee(bytes) view returns (uint256)"]);
const SYSTEMS_ABI = parseAbi([
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
]);
const REGISTRY_ABI = parseAbi([
  "function getContractAddressByName(string) view returns (address)",
]);

const lookup = (network: Network, name: string) =>
  client(network).readContract({
    address: REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getContractAddressByName",
    args: [name],
  });

/** Submits the request on-chain and returns the voting round it landed in. */
export async function submitRequest(network: Network, request: `0x${string}`) {
  const pc = client(network);
  const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("PRIVATE_KEY is not set");
  const account = privateKeyToAccount(key);
  const [hub, feeConfig, systems] = await Promise.all([
    lookup(network, "FdcHub"),
    lookup(network, "FdcRequestFeeConfigurations"),
    lookup(network, "FlareSystemsManager"),
  ]);
  const fee = await pc.readContract({
    address: feeConfig,
    abi: FEE_ABI,
    functionName: "getRequestFee",
    args: [request],
  });
  const wallet = createWalletClient({
    account,
    chain: NETWORKS[network].chain,
    transport: http(NETWORKS[network].rpc),
  });
  const hash = await wallet.writeContract({
    address: hub,
    abi: FDC_HUB_ABI,
    functionName: "requestAttestation",
    args: [request],
    value: fee,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  const block = await pc.getBlock({ blockNumber: receipt.blockNumber });
  const [firstTs, epoch] = await Promise.all([
    pc.readContract({ address: systems, abi: SYSTEMS_ABI, functionName: "firstVotingRoundStartTs" }),
    pc.readContract({ address: systems, abi: SYSTEMS_ABI, functionName: "votingEpochDurationSeconds" }),
  ]);
  const votingRound = Number((block.timestamp - firstTs) / epoch);
  return { hash, fee, votingRound, epochSeconds: Number(epoch) };
}

/** IXRPPayment.Response, as viem decodes it. */
export type XRPPaymentResponse = {
  attestationType: `0x${string}`;
  sourceId: `0x${string}`;
  votingRound: bigint;
  lowestUsedTimestamp: bigint;
  requestBody: { transactionId: `0x${string}`; proofOwner: `0x${string}` };
  responseBody: {
    blockNumber: bigint;
    blockTimestamp: bigint;
    sourceAddress: string;
    sourceAddressHash: `0x${string}`;
    receivingAddressHash: `0x${string}`;
    intendedReceivingAddressHash: `0x${string}`;
    spentAmount: bigint;
    intendedSpentAmount: bigint;
    receivedAmount: bigint;
    intendedReceivedAmount: bigint;
    hasMemoData: boolean;
    firstMemoData: `0x${string}`;
    hasDestinationTag: boolean;
    destinationTag: bigint;
    status: number;
  };
};

export type XRPPaymentProof = { merkleProof: `0x${string}`[]; data: XRPPaymentResponse };

const decodeResponse = (hex: `0x${string}`) =>
  decodeAbiParameters(RESPONSE_ABI, hex)[0] as unknown as XRPPaymentResponse;

/**
 * Polls the DA layer until the round is finalised. Rounds are ~90s and the
 * proof only appears once the round is signed, so this is minutes, not seconds.
 */
export async function fetchProof(
  network: Network,
  votingRoundId: number,
  request: `0x${string}`,
  { tries = 40, intervalMs = 15_000 } = {},
): Promise<XRPPaymentProof> {
  const cfg = FDC[network as keyof typeof FDC];
  for (let i = 0; i < tries; i++) {
    const res = await fetch(cfg.da, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
      body: JSON.stringify({ votingRoundId, requestBytes: request }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        response_hex?: `0x${string}`;
        proof?: `0x${string}`[];
      };
      if (body.response_hex) {
        return { merkleProof: body.proof ?? [], data: decodeResponse(body.response_hex) };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`no proof for round ${votingRoundId} after ${tries} tries`);
}

export { toHex };
