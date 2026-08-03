/**
 * End-to-end executor dry run for one XRPL payment:
 *   prove it with the FDC, then say what executeDirectMinting would do with it.
 *
 *   npm run prove -- <txHashHex> [network]
 *
 * Without PRIVATE_KEY it stops after preparing the request, which is enough to
 * confirm the verifier accepts the payment and costs nothing.
 */
import { parseAbi } from "viem";
import { prepareRequest, submitRequest, fetchProof } from "./fdc.js";
import { client, readLimits, type Network } from "./chain.js";
import { describe } from "./describe.js";

const txId = process.argv[2];
const network = (process.argv[3] ?? "coston2") as Network;
if (!txId) throw new Error("usage: npm run prove -- <txHashHex> [network]");
const transactionId = (txId.startsWith("0x") ? txId : `0x${txId}`).toLowerCase() as `0x${string}`;

const request = await prepareRequest(network, transactionId);
console.log(`\n  verifier accepted the payment`);
console.log(`  request ${request.slice(0, 66)}…\n`);

if (!process.env.PRIVATE_KEY) {
  console.log("  PRIVATE_KEY not set — stopping before the on-chain request.\n");
  process.exit(0);
}

const { hash, fee, votingRound, epochSeconds } = await submitRequest(network, request);
console.log(`  requested on-chain: ${hash}`);
console.log(`  fee ${fee} wei, voting round ${votingRound} (${epochSeconds}s rounds)\n`);

const proof = await fetchProof(network, votingRound, request, transactionId, {
  onWait: (m) => console.log(`  ${m}`),
});
const body = proof.data.responseBody;
const XRP = 1_000_000n;
console.log(`  proof: ${proof.merkleProof.length} merkle nodes`);
console.log(`  from ${body.sourceAddress}  received ${Number(body.receivedAmount) / Number(XRP)} XRP`);
console.log(`  destination tag ${body.hasDestinationTag ? body.destinationTag : "(none)"}` +
  `  memo ${body.hasMemoData ? body.firstMemoData.slice(0, 20) + "…" : "(none)"}`);

// Who would receive the FXRP, per the official tag manager. The verdict itself
// is describe(), which is pure and tested — this only fetches what it needs.
const snap = await readLimits(network);
let registered = null;
if (body.hasDestinationTag) {
  registered = await client(network).readContract({
    address: snap.mintingTagManager,
    abi: parseAbi(['function mintingRecipient(uint256) view returns (address)']),
    functionName: 'mintingRecipient',
    args: [body.destinationTag],
  });
}

const v = describe(proof, snap, registered);
console.log(`  recipient: ${v.recipient}`);
console.log(`  credited:  ${Number(v.netUba) / 1e6} FXRP of ${Number(v.receivedUba) / 1e6} XRP sent`);
console.log(
  "  rate limit: " +
    (v.rejected
      ? "REJECTED — below the minimum fee, this mints nothing"
      : v.delayed
        ? `DELAYED by ${v.reason} for ${v.waitSeconds}s — do not retry before then`
        : "clear, executes immediately"),
);
console.log(`  customer:  ${v.text}\n`);
