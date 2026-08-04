/**
 * Check every on-chain claim SUBMISSION.md makes, against Coston2.
 *
 *   node qa/verify-submission.mjs
 *
 * The submission is the document judges read, and its proof table is nothing
 * but public reads: transaction hashes, Flare's own contract addresses, and a
 * tag reservation. All of it can go stale without a line of code changing —
 * an address the registry now resolves differently, a tag someone else takes.
 *
 * The addresses in particular are Flare's, not ours. Writing them down is a
 * claim about the ContractRegistry, and the registry is the authority, so this
 * asks the registry rather than trusting the markdown.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { client } from "../src/chain.js";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const REGISTRY_ABI = parseAbi(["function getContractAddressByName(string) view returns (address)"]);
const TAG = 205n;

const md = fs.readFileSync(fileURLToPath(new URL("../SUBMISSION.md", import.meta.url)), "utf8");
const pc = client("coston2");

const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

// ---- the transactions the proof table cites ---------------------------------
//
// Every 32-byte hash in the table, whatever it is labelled. Taking them all
// means a new row is checked the moment it is written, rather than when someone
// remembers to add it here.
const table = md.slice(md.indexOf("## Proven on Coston2"), md.indexOf("Contracts used"));
const hashes = [...new Set([...table.matchAll(/`(0x[0-9a-f]{64})`/g)].map((m) => m[1]))];
check("the proof table still cites transactions", hashes.length >= 4, `${hashes.length} found`);

for (const hash of hashes) {
  try {
    const r = await pc.getTransactionReceipt({ hash });
    check(`${hash.slice(0, 12)}… succeeded`, r.status === "success", `status ${r.status}`);
  } catch (e) {
    check(`${hash.slice(0, 12)}… exists on Coston2`, false, String(e.shortMessage ?? e.message).split("\n")[0]);
  }
}

// ---- Flare's own addresses, per the registry rather than per the document ----
const named = {
  AssetManagerFXRP: /`AssetManagerFXRP` — Coston2 `(0x[0-9a-fA-F]{40})`/,
  MintingTagManager: /`MintingTagManager` — Coston2 `(0x[0-9a-fA-F]{40})`/,
  FdcHub: /`FdcHub` `(0x[0-9a-fA-F]{40})`/,
  FdcVerification: /`FdcVerification` `(0x[0-9a-fA-F]{40})`/,
  FtsoV2: /`FtsoV2` `(0x[0-9a-fA-F]{40})`/,
};

for (const [name, re] of Object.entries(named)) {
  const m = md.match(re);
  if (!m) {
    check(`SUBMISSION.md still names ${name}`, false, "the line is gone");
    continue;
  }
  // MintingTagManager is not a registry entry; the asset manager owns it.
  if (name === "MintingTagManager") continue;
  const resolved = await pc.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: "getContractAddressByName", args: [name],
  });
  check(
    `${name} is what the registry resolves`,
    resolved.toLowerCase() === m[1].toLowerCase(),
    `registry says ${resolved}, document says ${m[1]}`,
  );
}

// ---- the tag, which is the whole merchant claim -----------------------------
const tagManager = md.match(named.MintingTagManager)?.[1];
if (tagManager) {
  const owner = await pc.readContract({
    address: tagManager,
    abi: parseAbi(["function mintingRecipient(uint256) view returns (address)"]),
    functionName: "mintingRecipient",
    args: [TAG],
  });
  check(
    `destination tag ${TAG} is still reserved`,
    owner !== "0x0000000000000000000000000000000000000000",
    "mintingRecipient is the zero address — the reservation is gone, and the merchant flow in the demo does not work",
  );

  // The exclusivity row claims an allowed executor is set for the same tag.
  try {
    const exec = await pc.readContract({
      address: tagManager,
      abi: parseAbi(["function allowedExecutor(uint256) view returns (address)"]),
      functionName: "allowedExecutor",
      args: [TAG],
    });
    check(
      "an allowed executor is set for it, as the exclusivity row claims",
      exec !== "0x0000000000000000000000000000000000000000",
      "allowedExecutor is unset",
    );
  } catch (e) {
    check("allowedExecutor is readable", false, String(e.shortMessage ?? e.message).split("\n")[0]);
  }
}

console.log(`\n${checks} claims checked, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
