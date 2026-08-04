/**
 * Flow checks for the Buta landing page's sealed-bid demo.
 *
 *   node qa/flows-landing.mjs [pageDir|url]     default: ../buta/frontend/landing
 *
 * This is the interaction a judge actually clicks, and until now nothing
 * exercised it. render.mjs loads the page and checks it is not visibly broken;
 * it never presses Clear, so it could not tell whether the demo demonstrates
 * anything.
 *
 * The claim the page makes is specific and checkable: five sealed bids, the
 * highest wins, and it pays the SECOND price. If the button ever cleared at the
 * winner's own bid, the page would still look perfect and would be arguing
 * against the product.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname — a URL percent-encodes the space in the repo
// path, and the server then served a directory that does not exist. The page
// came up empty and the run died on a 30s timeout rather than a failed check.
const target = process.argv[2] ?? fileURLToPath(new URL("../../buta/frontend/landing", import.meta.url));
const live = /^https?:\/\//.test(target);

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("playwright is not installed — npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}
const { chromium } = playwright;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
function serve(root) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
      const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(root, "index.html");
      if (!fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });
}

const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const nums = (s) =>
  [...String(s ?? "").matchAll(/[\d][\d,]*\.?\d*/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter(Number.isFinite);

const { s, port } = live ? { s: { close() {} }, port: 0 } : await serve(target);
const url = live ? target : `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(1500);

// ---- happy path: sealed before, and only the outcome after ------------------

const sealedRows = await page.locator("#rows").innerText();
check("book starts sealed", /sealed|•|●|▪|\*/i.test(sealedRows) || nums(sealedRows).length === 0, sealedRows.slice(0, 60));
check("the state says it is awaiting the deadline", /sealed|awaiting/i.test(await page.innerText("#state")));
check("no clearing price is shown before clearing", await page.locator("#clearing").isHidden());

const rowCount = await page.locator("#rows > *").count();
check("five bids are on the book", rowCount === 5, `${rowCount} rows`);

await page.click("#clear-btn");
await page.waitForTimeout(1200);

const after = await page.locator("#rows").innerText();
const state = await page.innerText("#state");
check("clearing reveals an outcome", (await page.locator("#clearing").isVisible()) || /clear/i.test(state), state);

const clearingText = (await page.locator("#clearing").innerText().catch(() => "")) || state;
const clearing = nums(clearingText)[0];
check("a clearing price is quoted", Number.isFinite(clearing), clearingText.slice(0, 60));

// The privacy claim, checked rather than trusted: exactly one row opens, and
// the other four stay sealed. If clearing ever revealed the whole book, the
// page would be arguing against the product it is selling.
const won = (after.match(/WON/g) ?? []).length;
const stillSealed = (after.match(/SEALED/g) ?? []).length;
check("exactly one bidder is revealed as the winner", won === 1, `${won} winners`);
check("the four losing bids stay sealed", stillSealed === 4, `${stillSealed} still sealed`);
// Counting every digit was a bad heuristic: it picked up the truncated
// addresses. A bid is a price, so look for price-shaped text — there should be
// none in the book at all, because the only price on the page is the clearing
// one, and that lives in #clearing.
const pricesInBook = after.match(/\d\.\d{3,}/g) ?? [];
check("no bid amount is printed in the book", pricesInBook.length === 0, `saw ${pricesInBook}`);

// And the second-price rule itself. The book is fixed demo data, so the answer
// is a specific number: the runner-up's 0.5218, not the winner's own bid. A
// first-price mutation renders identically and would slip past every check
// above — this is the one that catches it.
const EXPECTED_SECOND_PRICE = 0.5218;
check(
  "the winner pays the SECOND price, not their own bid",
  clearing === EXPECTED_SECOND_PRICE,
  `cleared at ${clearing}, expected ${EXPECTED_SECOND_PRICE}`,
);

// ---- happy path: reset puts it back ----------------------------------------
await page.click("#reset-btn");
await page.waitForTimeout(800);
check("reset re-seals the book", await page.locator("#clearing").isHidden());
check("reset restores the awaiting state", /sealed|awaiting/i.test(await page.innerText("#state")));
check("reset keeps five bids", (await page.locator("#rows > *").count()) === 5, "row count changed");

// ---- wrong path: mashing the controls must not corrupt the demo -------------
//
// A judge who double-clicks Clear, or clears an already-cleared book, must not
// end up with a second clearing price, a NaN, or an empty book.
await page.click("#clear-btn");
await page.waitForTimeout(400);
// The page's own answer to the double-click: the button goes dead. That is the
// right answer, and asserting it is better than asserting that a second click
// happens to be harmless.
check("Clear is disabled once the book has cleared", await page.locator("#clear-btn").isDisabled());

// Force a click through the disabled state anyway — a determined judge, or a
// stale event, must not produce a second clearing.
await page.locator("#clear-btn").dispatchEvent("click").catch(() => {});
await page.waitForTimeout(400);
const mashed = (await page.locator("#rows").innerText()) + (await page.innerText("#state"));
check("a forced second clear does not produce NaN", !/NaN|undefined|Infinity/.test(mashed), mashed.slice(0, 80));
check("a forced second clear keeps the book intact", (await page.locator("#rows > *").count()) === 5);

for (let i = 0; i < 4; i++) {
  await page.click("#reset-btn");
  await page.click("#clear-btn");
}
await page.waitForTimeout(600);
const churned = (await page.locator("#rows").innerText()) + (await page.innerText("#state"));
check("alternating reset and clear stays clean", !/NaN|undefined|Infinity/.test(churned), churned.slice(0, 80));
check("and still shows five bids", (await page.locator("#rows > *").count()) === 5);

// ---- wrong path: nothing may throw -----------------------------------------
check("no uncaught page errors during any of it", pageErrors.length === 0, [...new Set(pageErrors)].join("; "));

await browser.close();
s.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
