/**
 * The executor bot. Watches the core vault on XRPL, proves incoming payments
 * with the FDC, and calls executeDirectMinting for the executor fee.
 *
 *   npm run bot -- [--tags 12,34] [--network coston2] [--once]
 *
 * With no --tags it serves every tag registered in the official
 * MintingTagManager whose allowed executor is us or nobody.
 *
 * The rule that shapes the whole loop: a delayed minting is a delay, not a
 * failure. The XRP is already at the core vault and the payment is already
 * recorded — never send a second XRPL payment, never re-request a proof, just
 * come back at allowedAt. Retrying early reverts DirectMintingStillDelayed and
 * burns gas.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { client, readLimits, xrpUsd, flrUsd, NETWORKS, type Network } from "./chain.js";
import { prepareRequest, submitRequest, fetchProof } from "./fdc.js";
import { predict } from "./limiter.js";
import { fees } from "./fees.js";
import { decide } from "./decide.js";
import { attemptPayment, type Entry as AttemptEntry } from "./attempt.js";
import { Ledger, importLegacyState, publicRecord, prune } from "./ledger.js";
import { attempt, breakEvenWinRate, payingPayment, COSTON2_MEASURED } from "./economics.js";

const XRPL_RPC = {
  coston2: "https://s.altnet.rippletest.net:51234/",
  flare: "https://xrplcluster.com/",
} as const;

const ARGS = process.argv.slice(2);
const arg = (name: string) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : undefined;
};
const network = (arg("network") ?? "coston2") as Network;
const once = ARGS.includes("--once");
const wantedTags = arg("tags")?.split(",").map((t) => BigInt(t.trim()));

const STATE_FILE = fileURLToPath(new URL(`../bot-state.${network}.json`, import.meta.url));

// One definition, in attempt.ts, because two copies of the state shape drift and
// the drift shows up as a type error at best and a lost proof at worst.
type Entry = AttemptEntry;
// One file per payment, in a directory, so more than one executor can run.
// The old single-file state let two processes each see "no request yet" and each
// buy an attestation, and let whichever saved second erase the other's record of
// a proof it had already paid for. Imported once so an upgrade does not re-buy
// everything the previous version owned.
const LEDGER_DIR = fileURLToPath(new URL(`../ledger.${network}/`, import.meta.url));
const ledger = new Ledger(LEDGER_DIR, process.env.EXECUTOR_ID ?? `pid-${process.pid}`);
const migrated = importLegacyState(ledger, STATE_FILE);
if (migrated) console.log(`imported ${migrated} payment(s) from ${STATE_FILE}`);

const EXECUTE_ABI = parseAbi([
  "struct RequestBody { bytes32 transactionId; address proofOwner; }",
  "struct ResponseBody { uint64 blockNumber; uint64 blockTimestamp; string sourceAddress; bytes32 sourceAddressHash; bytes32 receivingAddressHash; bytes32 intendedReceivingAddressHash; int256 spentAmount; int256 intendedSpentAmount; int256 receivedAmount; int256 intendedReceivedAmount; bool hasMemoData; bytes firstMemoData; bool hasDestinationTag; uint256 destinationTag; uint8 status; }",
  "struct Response { bytes32 attestationType; bytes32 sourceId; uint64 votingRound; uint64 lowestUsedTimestamp; RequestBody requestBody; ResponseBody responseBody; }",
  "struct Proof { bytes32[] merkleProof; Response data; }",
  "function executeDirectMinting(Proof) payable",
  "function directMintingDelayState(bytes32) view returns (uint8,uint256,uint256)",
]);

const TAG_ABI = parseAbi([
  "function mintingRecipient(uint256) view returns (address)",
  "function allowedExecutor(uint256) view returns (address)",
]);

/** XRPL timestamps count from 2000-01-01, not 1970. */
const RIPPLE_EPOCH = 946_684_800n;

async function coreVaultPayments(coreVault: string) {
  const res = await fetch(XRPL_RPC[network as keyof typeof XRPL_RPC], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_tx",
      params: [{ account: coreVault, limit: 30, ledger_index_min: -1, ledger_index_max: -1 }],
    }),
  });
  const body = (await res.json()) as any;
  return (body.result?.transactions ?? [])
    .map((t: any) => ({ tx: t.tx_json ?? t.tx ?? {}, meta: t.meta ?? {}, hash: t.hash ?? t.tx?.hash }))
    .filter(
      (t: any) =>
        t.tx.TransactionType === "Payment" &&
        t.meta.TransactionResult === "tesSUCCESS" &&
        t.tx.Destination === coreVault &&
        t.tx.DestinationTag !== undefined,
    );
}

async function tick() {
  const pc = client(network);
  const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("PRIVATE_KEY is not set");
  const account = privateKeyToAccount(key);
  const snap = await readLimits(network);
  const wallet = createWalletClient({
    account,
    chain: NETWORKS[network].chain,
    transport: http(NETWORKS[network].rpc),
  });

  const payments = await coreVaultPayments(snap.coreVaultAddress);
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${payments.length} tagged payments at the core vault`);

  for (const p of payments) {
    const tag = BigInt(p.tx.DestinationTag);
    const txId = `0x${p.hash}`.toLowerCase() as `0x${string}`;
    const held = ledger.claim(txId);
    if (!held.ok) {
      // Another executor has it, or it is finished. Either way, not ours.
      continue;
    }
    const entry = held.entry;
    if (wantedTags && !wantedTags.includes(tag)) continue;

    const [recipient, executor] = await Promise.all([
      pc.readContract({ address: snap.mintingTagManager, abi: TAG_ABI, functionName: "mintingRecipient", args: [tag] }),
      pc.readContract({ address: snap.mintingTagManager, abi: TAG_ABI, functionName: "allowedExecutor", args: [tag] }),
    ]);
    // On-chain truth about an earlier attempt beats anything cached locally.
    const [delayState, allowedAt] = (await pc.readContract({
      address: snap.assetManager,
      abi: EXECUTE_ABI,
      functionName: "directMintingDelayState",
      args: [txId],
    })) as [number, bigint, bigint];

    const call = decide({
      recipient,
      allowedExecutor: executor,
      me: account.address,
      now: snap.now,
      paidAt: p.tx.date === undefined ? null : BigInt(p.tx.date) + RIPPLE_EPOCH,
      exclusiveFor: snap.othersCanExecuteAfterSeconds,
      delayState: delayState as 0 | 1 | 2,
      allowedAt,
      finished: Boolean(entry.done),
    });
    if (call.action === "skip") {
      continue;
    }
    if (call.action === "wait") {
      ledger.save(txId, { ...entry, allowedAt: Number(call.until) });
      console.log(`  ${txId.slice(0, 12)} tag ${tag}: ${call.why} — waiting until ${new Date(Number(call.until) * 1000).toISOString().slice(11, 19)}, not retrying`);
      continue;
    }

    const amount = BigInt(p.tx.DeliverMax ?? p.tx.Amount ?? 0);
    const p2 = predict(snap, amount / snap.granularityUba, snap.now);
    if (p2.delayed && delayState === 0) {
      console.log(`  ${txId.slice(0, 12)} tag ${tag}: ${amount / 1_000_000n} XRP will be delayed (${p2.reason}) — the first call still has to register it`);
    }

    // Buy the proof once, retire a lost race, record what was actually earned.
    // That sequence lives in attempt.ts, where it can be tested without a chain
    // — it is the part where being wrong costs money.
    const say = (m: string) => console.log(`  ${txId.slice(0, 12)} tag ${tag}: ${m}`);
    const res = await attemptPayment(entry, amount, snap.fees, {
      requestProof: async () => {
        const request = await prepareRequest(network, txId);
        const sub = await submitRequest(network, request);
        return { request, votingRound: sub.votingRound };
      },
      fetchProof: (votingRound, request) =>
        fetchProof(network, votingRound, request as `0x${string}`, txId, { onWait: say }),
      simulate: async (proof) => {
        await pc.simulateContract({
          account,
          address: snap.assetManager,
          abi: EXECUTE_ABI,
          functionName: "executeDirectMinting",
          args: [proof as any],
        });
      },
      execute: async (proof) => {
        const h = await wallet.writeContract({
          address: snap.assetManager,
          abi: EXECUTE_ABI,
          functionName: "executeDirectMinting",
          args: [proof as any],
        });
        await pc.waitForTransactionReceipt({ hash: h });
        return h;
      },
      save: (e) => ledger.save(txId, { ...e, tag: String(tag) }),
      log: say,
    });
    if (res.outcome !== "won") continue;

    const hash = res.hash;
    const split = fees(amount, snap.fees);
    const xrp = (uba: bigint) => Number(uba) / 1e6; // bigint division would floor 0.1 to 0
    console.log(
      `  ${txId.slice(0, 12)} tag ${tag}: ${xrp(split.netUba)} FXRP to ${recipient}, ` +
        `${xrp(split.mintingFeeUba)} system fee, ${xrp(split.executorFeeUba)} to us — ${hash}`,
    );
  }
}

/**
 * The executor's own books. Racing is not free — every attempt costs an FDC
 * proof and gas whether or not it lands, so "we won one" is not the same as
 * "this is worth running".
 */
async function report() {
  // Totals come from the shared directory, so two executors serving different
  // tags still add up to one business rather than two half-answers.
  const t = ledger.totals();
  const won = { length: t.won };
  const lost = { length: t.lost };
  const pending = { length: t.pending };
  // Entries finished before the bot started labelling outcomes. Counting them
  // as neither is honest; counting them as wins would not be.
  const unlabelled = { length: t.unlabelled };
  const earned = t.earnedUba;

  console.log(`\n  executor report — ${network}`);
  console.log(`  won      ${won.length}`);
  console.log(`  lost     ${lost.length}   (proof and gas paid, fee to someone else)`);
  console.log(`  pending  ${pending.length}`);
  if (unlabelled.length) console.log(`  unknown  ${unlabelled.length}   (finished before outcomes were recorded)`);
  console.log(`  earned   ${Number(earned) / 1e6} XRP in executor fees`);
  if (won.length + lost.length > 0) {
    const rate = (100 * won.length) / (won.length + lost.length);
    console.log(`  win rate ${rate.toFixed(0)}%`);
  }

  // Whether any of that was worth doing. Gas is read live; the gas *amounts*
  // are the ones our own transactions actually burned. FLR is priced off the
  // FTSO because C2FLR has no price — a testnet token would flatter the
  // numbers into meaninglessness.
  const pc = client(network);
  const snap = await readLimits(network);
  const [gasPriceWei, xrp, flr] = await Promise.all([pc.getGasPrice(), xrpUsd(network), flrUsd(network)]);
  if (xrp === null || flr === null) {
    console.log(`\n  no FTSO price on ${network} — skipping the economics\n`);
    return;
  }
  const costs = { ...COSTON2_MEASURED, gasPriceWei, nativeUsd: flr, xrpUsd: xrp };
  const typical = snap.fees.minimumFeeUba + snap.fees.executorFeeUba + 5n * 1_000_000n;
  const a = attempt(typical, snap.fees, costs);
  const floor = payingPayment(snap.fees, costs);
  const breakEven = breakEvenWinRate(typical, snap.fees, costs);

  console.log(`\n  economics — gas ${Number(gasPriceWei) / 1e9} gwei, FLR $${flr.toFixed(4)}, XRP $${xrp.toFixed(4)}`);
  console.log(`  per win   +$${a.revenueUsd.toFixed(4)} fee  -$${a.winCostUsd.toFixed(4)} gas  = $${a.winMarginUsd.toFixed(4)}`);
  console.log(`  per loss  -$${a.lossCostUsd.toFixed(4)}  (the attestation, paid before you know)`);
  console.log(
    floor === null
      ? `  no payment size is profitable at this gas price`
      : `  smallest paying payment ${Number(floor) / 1e6} XRP`,
  );
  console.log(
    breakEven === null
      ? `  break-even win rate: unreachable`
      : `  break-even win rate ${(breakEven * 100).toFixed(1)}%`,
  );
  console.log();
}

if (ARGS.includes("--prune")) {
  // Finished payments only, older than thirty days. An unfinished one still
  // holds a proof we paid for, so it is never eligible however old it is.
  const gone = prune(ledger);
  console.log(gone.length ? `pruned ${gone.length} finished payment(s)` : "nothing old enough to prune");
} else if (ARGS.includes("--publish")) {
  // A record a merchant can read, not an operator dashboard. Losses included:
  // an executor record that only lists wins is an advert.
  const out = fileURLToPath(new URL(`../executor-record.${network}.json`, import.meta.url));
  const me = process.env.EXECUTOR_ID ?? `pid-${process.pid}`;
  const rec = publicRecord(ledger, me, network, new Date().toISOString());
  writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
  console.log(JSON.stringify(rec, null, 2));
  console.log(`\nwritten to ${out}`);
} else if (ARGS.includes("--report")) {
  await report();
} else {
  await tick();
  if (!once) setInterval(() => tick().catch((e) => console.error(e.message)), 20_000);
}
