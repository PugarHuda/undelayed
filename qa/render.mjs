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
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const pageDir = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../dashboard", import.meta.url));
// Resolved from this file, not from the cwd: run from inside qa/ and a
// cwd-relative default writes qa/qa/shots, which .gitignore (anchored at the
// repo root) does not cover, so throwaway screenshots turn up as untracked.
const shotDir = args.includes("--shots")
  ? args[args.indexOf("--shots") + 1]
  : fileURLToPath(new URL("./shots", import.meta.url));

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

  // Is the text actually readable, or is something painted over it? The dither
  // canvas rendering through the opening paragraph was found by a human looking
  // at a screenshot; this asks the browser instead. Hit-testing rather than
  // comparing pixels, so it does not go flaky when live numbers change width.
  const covered = await page.evaluate(() => {
    const TEXT = "h1,h2,h3,h4,p,li,td,th,a,label,figcaption,button";
    const hits = [];
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      for (const el of document.querySelectorAll(TEXT)) {
        if (!el.textContent.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.top < 0 || r.bottom > window.innerHeight) continue;
        // a point inside the first line of text, off the left edge where a
        // centred point could fall in the gap between words
        const x = Math.round(r.left + Math.min(r.width * 0.25, 40));
        const yy = Math.round(r.top + Math.min(r.height * 0.5, 8));
        const stack = document.elementsFromPoint(x, yy);
        const i = stack.indexOf(el);
        if (i < 0) continue; // not hit at all — probably a gap, not a cover
        const over = stack.slice(0, i).find((o) => !el.contains(o));
        if (!over) continue;
        const bg = getComputedStyle(over).backgroundColor;
        const opaque = over.tagName === "CANVAS" || over.tagName === "IMG" ||
          (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg));
        if (opaque) {
          hits.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${el.textContent.trim().slice(0, 28)}" under <${over.tagName.toLowerCase()}>`);
        }
      }
    }
    window.scrollTo(0, 0);
    return [...new Set(hits)];
  });
  for (const c of covered.slice(0, 4)) problems.push(`text covered: ${c}`);

  // "It rendered" is not "it has anything in it". A panel that reads the chain
  // and quietly stays on its loading text looks perfectly fine to every check
  // above.
  const empty = await page.evaluate(() =>
    [...document.querySelectorAll("table")]
      .filter((t) => !t.closest("[hidden]"))
      .filter((t) => {
        const b = t.querySelector("tbody");
        return !b || !b.rows.length || /reading chain|loading|…$/i.test(b.innerText.trim());
      })
      .map((t) => t.id || "table"),
  );
  for (const e of empty) problems.push(`empty panel: #${e}`);

  // A number that failed to compute renders perfectly. "NaN" in a fee table is
  // a wrong answer presented with total confidence, which is worse than a blank
  // one — and no type checker sees it, because NaN is a number.
  const bad = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("td, .big, .verdict, .note")) {
      const t = el.textContent || "";
      const m = t.match(/\b(NaN|undefined|null|Infinity|-Infinity)\b/);
      if (m) out.push(`${m[1]} in "${t.trim().slice(0, 40)}"`);
    }
    return [...new Set(out)];
  });
  for (const b of bad.slice(0, 4)) problems.push(`bad value: ${b}`);

  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, shot) });
  await ctx.close();

  console.log(`${engine}/${label}: ${problems.length ? problems.join("; ") : "ok"}`);
  return problems.length;
}

// A directory, or a deployed URL. Checking the built artifact is not the same
// as checking the page people open: the deploy config, the rewrites and the
// environment are all only real once it is live.
const live = /^https?:\/\//.test(pageDir);
const { s, port } = live ? { s: { close() {} }, port: 0 } : await serve(pageDir);
const url = live ? pageDir : `http://127.0.0.1:${port}/index.html`;
const name = live ? new URL(pageDir).hostname.split(".")[0] : path.basename(pageDir);
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

// --expect-fail: for the deliberately broken fixture. A checker nobody ever saw
// fail is not a checker, so the suite runs one page that must come back dirty.
if (args.includes("--expect-fail")) {
  if (bad) console.log("expected problems, and found them");
  else console.log("EXPECTED PROBLEMS AND FOUND NONE — the checks have stopped working");
  process.exit(bad ? 0 : 1);
}
process.exit(bad ? 1 : 0);
