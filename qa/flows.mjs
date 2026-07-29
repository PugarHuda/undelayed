/**
 * Flow checks: what happens when someone actually uses the page.
 *
 *   node qa/flows.mjs [pageDir|url]
 *
 * render.mjs loads a page and inspects it. It never types anything, so it can
 * only find what is wrong before the first interaction. Every bug below was
 * live on a page that render.mjs called clean.
 *
 * Both directions are checked on purpose:
 *   happy — the thing the page is for, end to end, with the numbers verified
 *   wrong — garbage, negatives, zero, absurd magnitudes, empty. A form that
 *           silently keeps the last good answer is worse than one that errors:
 *           it shows a real number for a question nobody asked.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "dashboard";
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

// ── assertions ───────────────────────────────────────────────────────────────

const failures = [];
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (ok) return;
  failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

/** Reads a labelled row out of one of the dashboard's two-column tables. */
async function row(page, tableId, label) {
  return page.evaluate(
    ([id, want]) => {
      const t = document.getElementById(id);
      for (const tr of t?.querySelectorAll("tbody tr") ?? []) {
        if ((tr.cells[0]?.textContent ?? "").trim().toLowerCase().startsWith(want.toLowerCase())) {
          return (tr.cells[1]?.textContent ?? "").trim();
        }
      }
      return null;
    },
    [tableId, label],
  );
}

const num = (s) => Number(String(s ?? "").replace(/[^0-9.-]/g, ""));

async function type(page, id, value) {
  await page.fill(`#${id}`, String(value));
  await page.waitForTimeout(150); // the input handler is synchronous; this is slack
}

// ── flows ────────────────────────────────────────────────────────────────────

async function run(page) {
  // ---- happy: the merchant checkout prices a basket -------------------------
  await type(page, "usd", "25");
  const sends = num(await row(page, "invoice", "Customer sends"));
  const gets = num(await row(page, "invoice", "Merchant receives"));
  const sysFee = num(await row(page, "invoice", "System fee"));
  const execFee = num(await row(page, "invoice", "Executor fee"));

  check("checkout: customer sends a positive amount", sends > 0, `${sends}`);
  check("checkout: merchant receives less than is sent", gets < sends, `${gets} vs ${sends}`);
  check(
    "checkout: the deductions account for the whole gap",
    Math.abs(sends - gets - sysFee - execFee) < 1e-6,
    `${sends} - ${gets} != ${sysFee} + ${execFee}`,
  );
  check("checkout: the shortfall is explained", /short by/i.test(await page.textContent("#inv-note")));

  // Doubling the price should roughly double what is sent, not stay put.
  await type(page, "usd", "50");
  const sends50 = num(await row(page, "invoice", "Customer sends"));
  check("checkout: the invoice follows the price", sends50 > sends * 1.5, `${sends} -> ${sends50}`);

  // ---- happy: the simulator and the splitter --------------------------------
  await type(page, "amount", "1");
  const small = (await page.textContent("#verdict")).trim();
  check("simulator: a small mint executes immediately", /immediately/i.test(small), small);
  check("simulator: no split offered when nothing is delayed", await page.isHidden("#split-wrap"));

  await type(page, "amount", "120000");
  const big = (await page.textContent("#verdict")).trim();
  check("simulator: a mint over the cliff is delayed", /delayed/i.test(big), big);
  check("simulator: the split table appears", await page.isVisible("#split-wrap"));
  const pieces = await page.evaluate(() => document.querySelectorAll("#split tbody tr").length);
  check("simulator: splitting produces more than one piece", pieces >= 2, `${pieces} pieces`);

  // ---- happy: the executor economics ---------------------------------------
  const margin = num(await row(page, "econ", "Margin per win"));
  const fee = num(await row(page, "econ", "Executor fee"));
  check("economics: a win earns something", fee > 0, `${fee}`);
  check("economics: the margin is below the fee", margin < fee, `${margin} vs ${fee}`);
  check("economics: a break-even rate is quoted", /breaks? even|no win rate/i.test(await page.textContent("#econ-note")));

  // ---- wrong path: input nobody should be able to break the page with ------
  //
  // The failure mode being hunted is not a crash. It is a form that ignores bad
  // input and leaves the previous answer on screen, so the page confidently
  // shows a real number for a question that was never asked.
  // "The note contains an em dash" is not evidence of anything — the ordinary
  // note has one. The signal has to be the table itself going away, because a
  // populated table IS the claim that the number on screen is the answer.
  for (const bad of ["abc", "-5", "0", "", "1e999", "--3", "1,5", "NaN"]) {
    // Re-establish a known good answer before each one. Without this, a bad
    // input is compared against whatever the PREVIOUS bad input left behind,
    // and a stale value slips through because it is stale from one step ago
    // rather than two.
    await type(page, "usd", "25");
    const before = await row(page, "invoice", "Customer sends");
    check("wrong-path setup: a good price populates the table", before !== null, `${before}`);

    await type(page, "usd", bad);
    const now = await row(page, "invoice", "Customer sends");
    const note = (await page.textContent("#inv-note")) ?? "";
    const stale = now !== null && now === before;
    check(`checkout does not keep a stale answer for ${JSON.stringify(bad)}`, !stale, `still showing ${now}`);
    check(
      `checkout says why it cannot price ${JSON.stringify(bad)}`,
      now !== null || /not a (price|number)|enter|cannot/i.test(note),
      `note: ${note.slice(0, 80)}`,
    );
    // Only the computed cells. A message that quotes what was typed is correct
    // behaviour, so "NaN" appearing inside quotes is not a finding.
    check(
      `checkout shows no NaN for ${JSON.stringify(bad)}`,
      !/NaN|Infinity|undefined/.test(await page.textContent("#invoice")),
    );
    check(
      `checkout's message for ${JSON.stringify(bad)} is not itself broken`,
      !/NaN|Infinity|undefined/.test(note.replace(/"[^"]*"/g, "")),
      note.slice(0, 80),
    );
  }

  for (const bad of ["abc", "-1", "0", "", "1e999"]) {
    await type(page, "amount", bad);
    const v = (await page.textContent("#verdict")) ?? "";
    const p = (await page.textContent("#price")) ?? "";
    check(
      `simulator shows no NaN for ${JSON.stringify(bad)}`,
      !/NaN|Infinity|undefined/.test(v + p),
      `${v} / ${p}`,
    );
  }

  // ---- wrong path: the page must survive a network switch mid-edit ---------
  await type(page, "amount", "120000");
  await page.click('#nets button[data-net="flare"]');
  // Wait for the condition, not for a guess at how long a mainnet read takes.
  // A fixed sleep here was flaky, which in a check is worse than slow: it fails
  // for reasons that have nothing to do with the page.
  let switched = true;
  try {
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll("#limits tbody tr");
        return rows.length >= 2 && !/reading chain/i.test(rows[0].textContent ?? "");
      },
      { timeout: 30_000 },
    );
  } catch {
    switched = false;
  }
  check("network switch reloads the limiter table", switched, "still on the loading row after 30s");
  const after = (await page.textContent("#verdict")) ?? "";
  check("network switch keeps the simulator answering", after.trim().length > 0 && !/NaN/.test(after), after);
}

// ── driver ───────────────────────────────────────────────────────────────────

const { s, port } = live ? { s: { close() {} }, port: 0 } : await serve(target);
const url = live ? target : `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(6000); // the page reads the chain before it can answer

try {
  await run(page);
} catch (e) {
  failures.push(`flow threw: ${e.message}`);
}
for (const e of [...new Set(pageErrors)]) failures.push(`page error: ${e}`);

await browser.close();
s.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
