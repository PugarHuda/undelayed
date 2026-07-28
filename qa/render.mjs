/**
 * Renders a static page in real browser engines and fails on anything that
 * would embarrass it in a demo: console errors, page errors, failed requests,
 * horizontal overflow, and — on WebKit, which is what iOS Safari runs — a
 * 100dvh that disagrees with the actual viewport.
 *
 *   node qa/render.mjs [pageDir] [--shots <dir>]
 *
 * Needs playwright with chromium and webkit installed:
 *   npm i -D playwright && npx playwright install chromium webkit
 *
 * It is deliberately not a dependency of the build. It is the check that found
 * the two bugs neither the type checker nor the unit tests could see: a
 * masthead that pushed the page 19px wide on a phone, and a hero canvas that
 * rendered its dither straight through the opening paragraph.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const pageDir = args.find((a) => !a.startsWith("--")) ?? new URL("../dashboard", import.meta.url).pathname.slice(1);
const shotDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : "qa/shots";

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error("playwright is not installed — npm i -D playwright && npx playwright install chromium webkit");
  process.exit(2);
}
const { chromium, webkit, devices } = playwright;

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

async function check(browser, engine, label, contextOptions, url, shot) {
  const ctx = await browser.newContext(contextOptions);
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 160)}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url().slice(0, 80)}`));

  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(6000); // pages that read the chain need a moment

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:100dvh;width:1px;pointer-events:none";
    document.body.appendChild(probe);
    const dvh = probe.getBoundingClientRect().height;
    probe.remove();
    return { overflow: de.scrollWidth - de.clientWidth, dvh, inner: window.innerHeight };
  });
  if (m.overflow > 2) problems.push(`horizontal overflow: ${m.overflow}px`);
  if (Math.abs(m.dvh - m.inner) > 2) problems.push(`100dvh ${m.dvh} != viewport ${m.inner}`);

  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, shot) });
  await ctx.close();

  console.log(`${engine}/${label}: ${problems.length ? problems.join("; ") : "ok"}`);
  return problems.length;
}

const { s, port } = await serve(pageDir);
const url = `http://127.0.0.1:${port}/index.html`;
const name = path.basename(pageDir);
let bad = 0;

const cr = await chromium.launch();
bad += await check(cr, "chromium", "desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, url, `${name}-desktop.png`);
bad += await check(cr, "chromium", "narrow", { viewport: { width: 320, height: 800 }, deviceScaleFactor: 2 }, url, `${name}-320.png`);
await cr.close();

const wk = await webkit.launch();
bad += await check(wk, "webkit", "iPhone 13", devices["iPhone 13"], url, `${name}-ios.png`);
await wk.close();

s.close();
console.log(bad ? `\n${bad} problem(s)` : "\nclean");
process.exit(bad ? 1 : 0);
