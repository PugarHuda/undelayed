/**
 * Pixel diff against a committed baseline.
 *
 *   node qa/visual.mjs [pageDir|url] [--update]
 *
 * The other checks read the DOM. They catch a panel that never loaded, text
 * painted over, a number that came out NaN — everything except the page simply
 * looking wrong. A colour token that stops resolving, a font that fails to
 * subset, a border that vanishes: the DOM is unchanged and every assertion
 * passes.
 *
 * No image library. Chromium already decodes PNG, so the comparison happens
 * inside the browser: both images go onto a canvas, and the diff is counted in
 * page context. That keeps this to one file and no new dependency.
 *
 * Baselines live in qa/baseline/ and are committed. `--update` rewrites them,
 * which is a deliberate act — a baseline refreshed without looking is a check
 * turned off.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "dashboard";
const update = args.includes("--update");
const live = /^https?:\/\//.test(target);

/** A pixel differing by more than this in any channel counts as changed. */
const CHANNEL_TOLERANCE = 8;
/** Fraction of pixels allowed to change before it is a failure. */
const MAX_CHANGED = 0.002; // 0.2% — antialiasing moves a little between runs

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

const BASELINE = fileURLToPath(new URL("./baseline/", import.meta.url));
fs.mkdirSync(BASELINE, { recursive: true });

const name = live ? new URL(target).hostname.split(".")[0] : path.basename(target);

// Both themes. The page defines a full dark palette under
// prefers-color-scheme, and forcing light meant half of it was never compared —
// a colour that stops resolving in dark mode would have looked perfectly fine.
const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900, scheme: "light" },
  { label: "narrow", width: 390, height: 844, scheme: "light" },
  { label: "desktop-dark", width: 1440, height: 900, scheme: "dark" },
  { label: "narrow-dark", width: 390, height: 844, scheme: "dark" },
];

/**
 * Counts differing pixels by drawing both PNGs on canvases. Runs in the page,
 * because that is where a PNG decoder already exists.
 */
async function diffCount(page, aB64, bB64) {
  return page.evaluate(
    async ([a, b, tol]) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = "data:image/png;base64," + src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      }
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const da = px(ia);
      const db = px(ib);
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i] - db[i]) > tol ||
          Math.abs(da[i + 1] - db[i + 1]) > tol ||
          Math.abs(da[i + 2] - db[i + 2]) > tol
        ) {
          changed++;
        }
      }
      return { changed, total: da.length / 4 };
    },
    [aB64, bB64, CHANNEL_TOLERANCE],
  );
}

const { s, port } = live ? { s: { close() {} }, port: 0 } : await serve(target);
const url = live ? target : `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch();
const failures = [];
let checks = 0;

// A second, blank page is where the comparison runs, so the page under test is
// never touched by it.
const judge = await (await browser.newContext()).newPage();
await judge.goto("about:blank");

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    // Freeze what would otherwise differ every run.
    colorScheme: vp.scheme ?? "light",
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(6000); // chain reads settle

  // Put the simulator in a state the chain cannot change. #split-wrap only
  // appears when the mint is delayed, and whether 120,000 XRP is delayed depends
  // on the live limiter — so the panel came and went and moved thousands of
  // pixels for reasons that had nothing to do with the page. Hiding it was the
  // first fix and it was the wrong one: the check then never saw the split table
  // at all. An amount at or above the large-mint threshold is ALWAYS delayed,
  // whatever the limiter says, so the panel is always there and always compared.
  const amount = await page.$("#amount");
  if (amount) {
    await amount.fill("999999999");
    await page.waitForTimeout(500);
  }

  // Volatile content is REPLACED, not hidden.
  //
  // Hiding it was the first attempt and it quietly gutted the check: the
  // sections carrying the live numbers are also the ones carrying the accent
  // colour, the borders and most of the type, so a changed colour token moved
  // exactly zero pixels. Overwriting the text keeps every box, rule, font and
  // colour in the frame and only pins the digits.
  await page.evaluate(() => {
    const volatile = [
      "#limits tbody td", "#capacity", "#invoice tbody td", "#econ tbody td",
      "#split tbody td", "#addr", "#verdict", "#price", "#capnote",
      "#stale-note", "#inv-note", "#econ-note", "#customer-line", ".readout",
    ];
    for (const sel of volatile) {
      for (const el of document.querySelectorAll(sel)) {
        // A FIXED length, not the original's. Matching the length looked
        // considerate and made the check flaky: a live number that grew from
        // five digits to seven moved real pixels, so the baseline failed for
        // the chain's reasons rather than the page's.
        el.textContent = "00000000";
      }
    }
    // The WebGL plate never renders the same twice.
    for (const c of document.querySelectorAll("canvas")) c.style.visibility = "hidden";
  });
  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
  });
  await page.waitForTimeout(400);

  const shot = (await page.screenshot({ fullPage: false })).toString("base64");
  await ctx.close();

  const file = path.join(BASELINE, `${name}-${vp.label}.png`);
  if (update || !fs.existsSync(file)) {
    fs.writeFileSync(file, Buffer.from(shot, "base64"));
    console.log(`${update ? "updated" : "created"} baseline ${path.basename(file)}`);
    continue;
  }

  checks++;
  const base = fs.readFileSync(file).toString("base64");
  const r = await diffCount(judge, base, shot);
  if (r.sizeMismatch) {
    failures.push(`${vp.label}: size changed, ${r.sizeMismatch}`);
    continue;
  }
  const frac = r.changed / r.total;
  const verdict = `${vp.label}: ${r.changed}/${r.total} pixels (${(frac * 100).toFixed(3)}%)`;
  if (frac > MAX_CHANGED) {
    const out = path.join(BASELINE, `${name}-${vp.label}.actual.png`);
    fs.writeFileSync(out, Buffer.from(shot, "base64"));
    failures.push(`${verdict} — wrote ${path.basename(out)} to compare`);
  } else {
    console.log(`${verdict} ok`);
  }
}

await browser.close();
s.close();

if (!checks && !update) {
  console.log("\nbaselines created — run again to compare, and commit them");
  process.exit(0);
}
console.log(`\n${checks} viewport(s), ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
