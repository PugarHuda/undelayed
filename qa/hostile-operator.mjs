/**
 * The desk, fed by an operator that lies.
 *
 *   node qa/hostile-operator.mjs [deskUrl]
 *
 * Needs a desk pointed at this script's server:
 *   cd buta/frontend && VITE_TEE_PROXY_URL=http://127.0.0.1:6699 npx vite --port 5175
 *
 * The submission's whole claim is that the party relaying for the enclave is
 * not trusted. The desk trusted it completely — it called .toLocaleString() on
 * whatever LIST_RFQS returned. A row missing `lot`, or a response that was an
 * object rather than an array, threw during render and WHITE-SCREENED the desk:
 * no book, no message, nothing at all. A hostile operator needed no cleverness
 * to do it, and version skew between enclave and desk would do it by accident.
 */
import http from "node:http";
import crypto from "node:crypto";
import { decrypt } from "../../buta/frontend/node_modules/ecies-geth/dist/lib/src/typescript/node.js";
import { chromium } from "playwright";
import { installWallet, connect } from "./wallet.mjs";

const CASES = {
  "negative and absurd numbers": [
    { rfqId: -1, maker: "0x1", pair: "FXRP/USDT0", lot: -5000, deadline: -9, bidCount: -3, cleared: false },
    { rfqId: 1e308, maker: "0x2", pair: "A/B", lot: 1e308, deadline: 1e308, bidCount: 1e308, cleared: false },
  ],
  "missing fields": [{ rfqId: 1 }],
  "wrong types": [{ rfqId: "one", maker: 5, pair: null, lot: "lots", deadline: {}, bidCount: [], cleared: "yes" }],
  "html and script in strings": [
    { rfqId: 2, maker: "<img src=x onerror=alert(1)>", pair: "<script>alert(2)</script>", lot: 1, deadline: 1, bidCount: 0, cleared: false },
  ],
  "cleared with no winner": [{ rfqId: 3, maker: "0x3", pair: "A/B", lot: 1, deadline: 1, bidCount: 0, cleared: true }],
  "not an array": { rfqId: 1 },
};

// The receipts path, which Portfolio renders with .slice() on the commitment.
// Guarding the book and leaving this raw was half a fix.
const BID_CASES = {
  "receipt with no commitment": [{ rfqId: 1, pair: "A/B", cleared: false, won: false }],
  "receipt commitment is a number": [{ rfqId: 1, pair: "A/B", commitment: 5, cleared: false, won: false }],
  "receipts are not an array": { rfqId: 1 },
};

const b32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
let payload = [];
let bidPayload = [];
// A key we hold the private half of, offered in place of the enclave's, plus
// every ciphertext the desk hands us.
let operatorKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]);
let captured = [];
const asked = new Map();
const srv = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.url === "/info") {
    const x = "0x" + operatorKey.subarray(1, 33).toString("hex");
    const y = "0x" + operatorKey.subarray(33, 65).toString("hex");
    return res.end(JSON.stringify({ machineData: { publicKey: { x, y } } }));
  }
  // Remember which command each action id was for, so the result answers the
  // question that was actually asked — the book and the receipts are different
  // read paths and were guarded at different times.
  if (req.url === "/direct") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      let cmd = "LIST_RFQS";
      try {
        const sent = JSON.parse(body);
        cmd = Buffer.from(sent.opCommand.slice(2), "hex").toString().replace(/\0+$/, "");
        // Keep every sealed opening the desk hands us. Whether we can open one
        // is the whole question.
        const inner = JSON.parse(Buffer.from(sent.message.slice(2), "hex").toString());
        if (inner.ciphertext) captured.push(inner.ciphertext);
      } catch {
        /* the desk copes or a check says so */
      }
      const id = "0x" + (asked.size + 1).toString(16).padStart(64, "0");
      asked.set(id, cmd);
      res.end(JSON.stringify({ data: { id } }));
    });
  }
  const id = (req.url.match(/result\/(0x[0-9a-f]+)/) || [])[1] ?? "";
  const cmd = asked.get(id) ?? "LIST_RFQS";
  const data = cmd === "GET_MY_BIDS" ? bidPayload : payload;
  const hex = "0x" + Buffer.from(JSON.stringify(data)).toString("hex");
  res.end(JSON.stringify({ result: { id: "0x00", submissionTag: "submit", status: 1, log: "ok", opType: b32("BUTA"), opCommand: b32(cmd), data: hex } }));
});
await new Promise((r) => srv.listen(6699, "127.0.0.1", r));

const failures = [];
let checks = 0;
const browser = await chromium.launch();
for (const [name, data] of Object.entries(CASES)) {
  payload = data;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).split("\n")[0].slice(0, 90)));
  let alerted = false;
  p.on("dialog", async (d) => { alerted = true; await d.dismiss(); });
  await p.goto(process.argv[2] ?? "http://localhost:5175/dashboard/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4500);
  const t = await p.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  const bad = /NaN|undefined|Infinity|\[object/i.test(t);
  const why = [];
  if (errs.length) why.push(`threw: ${errs[0]}`);
  if (bad) why.push(`rendered ${(t.match(/NaN|undefined|Infinity|\[object \w+/i) || [""])[0]}`);
  if (alerted) why.push("EXECUTED SCRIPT SUPPLIED BY THE OPERATOR");
  if (t.trim().length < 30) why.push("blank page");
  checks++;
  if (why.length) failures.push(`${name}: ${why.join(", ")}`);
  await ctx.close();
}
// The receipts, which only render once a wallet is connected — so this half
// needs one. The book stays well-formed here so that anything that breaks is
// the receipt path and not the book path.
payload = [
  { rfqId: 1, maker: "0x1111111111111111111111111111111111111111", pair: "A/B", lot: 10, deadline: 99, bidCount: 0, cleared: false },
];
for (const [name, data] of Object.entries(BID_CASES)) {
  bidPayload = data;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const w = await installWallet(ctx);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).split("\n")[0].slice(0, 90)));
  await p.goto(process.argv[2] ?? "http://localhost:5175/dashboard/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);
  await connect(p, w);
  const folio = p.locator("button", { hasText: /^▸? ?portfolio$/i }).first();
  if (await folio.count()) {
    await folio.click().catch(() => {});
    await p.waitForTimeout(2500);
  }
  const t = await p.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
  const why = [];
  if (errs.length) why.push(`threw: ${errs[0]}`);
  if (/NaN|undefined|\[object/i.test(t)) why.push(`rendered ${(t.match(/NaN|undefined|\[object \w+/i) || [""])[0]}`);
  if (t.trim().length < 30) why.push("blank page");
  checks++;
  if (why.length) failures.push(`${name}: ${why.join(", ")}`);
  await ctx.close();
}

// ---- the one that matters: whose key is a bid encrypted to? -----------------
//
// A bid opening is ECIES-encrypted so that only the enclave can read it. The
// desk used to fetch that key from the operator's own GET /info — the one place
// it must not come from. An operator answering with a key of their own reads
// every bid amount and every reserve, the ciphertext looks no different, the
// commitment still binds, and the desk keeps working perfectly while the book is
// read over their shoulder.
//
// So: serve a key we hold the private half of, let the desk seal a bid, and try
// to decrypt what it sent. If it opens, the desk trusted us.
{
  const priv = crypto.randomBytes(32);
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(priv);
  operatorKey = ecdh.getPublicKey(); // 65 bytes, uncompressed
  captured = [];

  payload = [
    { rfqId: 1, maker: "0x1111111111111111111111111111111111111111", pair: "FXRP/USDT0", lot: 1000, deadline: 99_999_999, bidCount: 0, cleared: false },
  ];
  bidPayload = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const w = await installWallet(ctx);
  const p = await ctx.newPage();
  await p.goto(process.argv[2] ?? "http://localhost:5175/dashboard/", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(4000);
  await connect(p, w);
  await p.waitForTimeout(1500);
  const field = p.locator("label", { hasText: /your bid/i }).locator("input").first();
  if (await field.count()) {
    await field.fill("424242");
    await p.locator("button", { hasText: /^seal bid$/i }).first().click().catch(() => {});
    await p.waitForTimeout(6000);
  }

  checks++;
  if (!captured.length) {
    // Refusing to seal at all is a safe outcome — the desk says it cannot read
    // the enclave's key from the chain rather than trusting ours.
    const said = (await p.textContent("body")) ?? "";
    if (!/refusing rather than trusting|cannot read the enclave/i.test(said)) {
      failures.push("substituted key: the desk sealed nothing and did not say why");
    }
  } else {
    let opened = false;
    for (const ct of captured) {
      try {
        await decrypt(priv, Buffer.from(ct.slice(2), "hex"));
        opened = true;
      } catch {
        /* could not open it, which is the point */
      }
    }
    if (opened) {
      failures.push(
        "substituted key: the bid opened with the OPERATOR's private key — every amount and reserve is readable by whoever relays",
      );
    }
  }
  await ctx.close();
}

await browser.close();
srv.close();

console.log(`\n${checks} hostile responses, ${failures.length} got through`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
