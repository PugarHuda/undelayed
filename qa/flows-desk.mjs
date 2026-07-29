/**
 * Flow checks for the Buta desk.
 *
 *   node qa/flows-desk.mjs [url]        default: https://buta-app.vercel.app
 *
 * The desk has no backend in production — no TEE machine is registered for the
 * extension — so the happy path here is the honest-offline one: the page says
 * it is on demo data, shows a book anyway, and every control that cannot work
 * without a wallet or an extension says so instead of pretending.
 *
 * That is worth checking precisely BECAUSE it is the fallback. A judge opening
 * the link sees this and nothing else, and a fallback nobody exercises is a
 * fallback that quietly rots.
 */
let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("playwright is not installed — npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}
const { chromium } = playwright;

const url = process.argv[2] ?? "https://buta-app.vercel.app";

const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();

const pageErrors = [];
const requests = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
page.on("request", (r) => requests.push(r.url()));

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(5000);

const body = (await page.textContent("body")) ?? "";

// ---- happy path: the offline state is stated, not implied -------------------
check("desk says the extension is offline", /extension offline/i.test(body));
check("desk says the data is demo data", /demo data/i.test(body));
check("desk says how to get the live flow", /go run \.\/cmd\/dev/i.test(body));

// ---- happy path: there is still a book, and it is readable ------------------
const rows = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((t) => /FXRP\//.test(t)).length,
);
check("desk shows a book rather than an empty screen", rows >= 3, `${rows} rows`);
check("the book states each auction's state", /SEALED|CLEARED/i.test(body));

// ---- happy path: selecting an auction opens it ------------------------------
const firstRow = page.locator("button", { hasText: /FXRP\// }).first();
await firstRow.click();
await page.waitForTimeout(800);
const afterSelect = (await page.textContent("body")) ?? "";
check("selecting an auction changes the page", afterSelect !== body);

// ---- wrong path: no wallet, so the actions must refuse, not throw -----------
//
// Nothing here is connected. Every button that needs a signature has to say so
// rather than silently doing nothing or blowing up in the console.
const before = pageErrors.length;
const buttons = await page.locator("button").all();
let clicked = 0;
for (const b of buttons.slice(0, 14)) {
  if (!(await b.isVisible()) || (await b.isDisabled())) continue;
  const label = ((await b.textContent()) ?? "").trim().slice(0, 24);
  if (/connect/i.test(label)) continue; // opens a wallet modal; not our concern
  await b.click({ timeout: 3000 }).catch(() => {});
  clicked++;
  await page.waitForTimeout(120);
}
check("wrong path: clicking through the desk unconnected exercised something", clicked > 0, `${clicked} buttons`);
check(
  "wrong path: no uncaught error from acting without a wallet",
  pageErrors.length === before,
  pageErrors.slice(before).join("; "),
);

// ---- wrong path: the desk must not phone home to a proxy it does not own ----
const foreign = requests.filter(
  (u) => /flare\.rocks|walletconnect|web3modal/i.test(u),
);
check(
  "wrong path: no requests to third-party or borrowed infrastructure",
  foreign.length === 0,
  [...new Set(foreign)].slice(0, 3).join(", "),
);

// ---- wrong path: and it must not poll an endpoint that cannot answer --------
const before404 = requests.filter((u) => /\/direct$/.test(u)).length;
await page.waitForTimeout(6000);
const after404 = requests.filter((u) => /\/direct$/.test(u)).length;
check(
  "wrong path: the desk stops asking a backend that is not there",
  after404 === before404,
  `${after404 - before404} more /direct calls in 6s`,
);

await browser.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
