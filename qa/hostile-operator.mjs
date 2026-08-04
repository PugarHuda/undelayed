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
import { chromium } from "playwright";

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

const b32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
let payload = [];
const srv = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.url === "/info") return res.end(JSON.stringify({ machineData: { publicKey: { x: "0x" + "11".repeat(32), y: "0x" + "22".repeat(32) } } }));
  if (req.url === "/direct") { req.resume(); return res.end(JSON.stringify({ data: { id: "0x" + "ab".repeat(32) } })); }
  const hex = "0x" + Buffer.from(JSON.stringify(payload)).toString("hex");
  res.end(JSON.stringify({ result: { id: "0x00", submissionTag: "submit", status: 1, log: "ok", opType: b32("BUTA"), opCommand: b32("LIST_RFQS"), data: hex } }));
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
await browser.close();
srv.close();

console.log(`\n${checks} hostile books, ${failures.length} got through`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
