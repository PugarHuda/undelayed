/**
 * Flow checks for the Buta desk.
 *
 *   node qa/flows-desk.mjs [url]        default: https://buta-desk.vercel.app/dashboard
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
const { installWallet, connect } = await import("./wallet.mjs");

const url = process.argv[2] ?? "https://buta-desk.vercel.app/dashboard";

const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const wallet = await installWallet(ctx);
const page = await ctx.newPage();

const pageErrors = [];
const requests = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
page.on("request", (r) => requests.push(r.url()));

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(5000);

const body = (await page.textContent("body")) ?? "";

// Whether this desk has a backend behind it. The deployed one does not, and a
// few checks below only make sense in one case or the other — asserting the
// offline behaviour against a healthy local stack would fail for being healthy.
const onDemo = /demo data/i.test(body);

// ---- wrong path: it must not poll an endpoint that cannot answer ------------
//
// Measured here, before anything is clicked. Posting a block and sealing a bid
// both hit /direct on demand whatever the configuration, so counting later made
// "no proxy is configured" untrue on the deployed desk and quietly turned this
// check off — it reported a configured proxy against a build that has none.
const beforePoll = requests.filter((u) => /\/direct$/.test(u)).length;
await page.waitForTimeout(6000);
const afterPoll = requests.filter((u) => /\/direct$/.test(u)).length;
// A build that IS pointed at a proxy is supposed to poll it, and a local
// preview inherits a proxy URL from .env — gating on the demo banner instead
// would fail there for a configuration difference rather than a bug.
if (beforePoll === 0) {
  check(
    "wrong path: the desk stops asking a backend that is not there",
    afterPoll === 0,
    `${afterPoll} /direct calls in 6s`,
  );
} else {
  console.log(`  (a proxy is configured — skipped the no-polling check, ${afterPoll - beforePoll} calls in 6s)`);
}

// ---- happy path: the offline state is stated, not implied -------------------
// The masthead used to say EXTENSION OFFLINE whenever this browser could not
// reach a proxy, which conflated two different facts. The machine is registered
// and PRODUCTION on Coston2; not being able to reach it from a browser is a
// separate thing, and the page has to say which is which.
check(
  "desk states the TEE state it can actually read from the chain",
  /tee\s+production|extension offline/i.test(body),
  body.slice(0, 80),
);
check(
  "desk does not claim the extension is unregistered while it is in production",
  !/tee\s+production/i.test(body) || !/extension offline/i.test(body),
  "the masthead says both PRODUCTION and OFFLINE",
);
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

// ---- happy path: the desk is usable before anything is clicked --------------
//
// It used to open on a three-tab strip with nothing selected, so the first
// thing anyone saw was "Select an auction on the left to bid on it" — and the
// top row is usually a CLEARED auction, which led to a dead end. The desk now
// selects the first OPEN auction itself. These run before any click, on purpose.
check(
  "the bid form is on screen without anyone selecting anything",
  /your bid/i.test(body),
  "no bid form on load",
);
check(
  "the desk did not open on a cleared auction",
  !/has cleared, so its book is closed/i.test(body),
  "landed on a closed auction",
);
check("the state of the desk is stated in counts", /open/i.test(body) && /sealed bids/i.test(body));
check(
  "posting is offered without a selection",
  (await page.locator("button", { hasText: /^post a block$/i }).count()) > 0,
);

// ---- wrong path: a cleared auction offers a way on, not a dead end ----------
const clearedRow = page.locator("button", { hasText: /FXRP\// }).filter({ hasText: /CLEARED/i }).first();
if (await clearedRow.count()) {
  await clearedRow.click();
  await page.waitForTimeout(700);
  const onCleared = (await page.textContent("body")) ?? "";
  check("a cleared auction explains itself", /has cleared/i.test(onCleared), onCleared.slice(0, 60));
  check(
    "and offers the next move rather than stopping",
    (await page.locator("button", { hasText: /bid on rfq|post a block/i }).count()) > 0,
    "dead end",
  );
}

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
  // The wallet control opens a modal that covers the page, and every click
  // after it lands on the overlay — the loop would then "pass" by testing
  // nothing. Both labels are it: unconnected it says Connect, connected it is
  // the truncated address.
  if (/connect|0x[0-9a-f]{2}…|dropdown/i.test(label)) continue;
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

// ---- wrong path: the forms, unconnected and with nonsense in them -----------
//
// Clicking buttons proves they do not throw. Filling the forms proves the desk
// refuses for a reason it can state. Nothing here is connected, so every action
// has to end in a message rather than a silent no-op or a console trace.
async function fillByLabel(label, value) {
  const field = page.locator("label", { hasText: label }).locator("input").first();
  if (!(await field.count())) return false;
  await field.fill(String(value));
  return true;
}

const beforeForms = pageErrors.length;
const postTab = page.locator("button", { hasText: /post a block/i }).first();
if (await postTab.count()) {
  await postTab.click().catch(() => {});
  await page.waitForTimeout(500);
}

// A plausible block, then a series of values nobody should be able to submit.
const filled = await fillByLabel("Lot (base units)", "120000");
check("wrong path: the post form is reachable", filled, "no Lot field found");

if (filled) {
  const action = page.locator("button", { hasText: /^post block/i }).last();

  // The right answer to "post a block with no wallet" is to ask for a wallet.
  await action.click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(900);
  const prompted =
    (await page.locator("[data-rk]").count()) > 0 ||
    /connect|wallet/i.test((await page.textContent("body")) ?? "");
  check("wrong path: posting unconnected asks for a wallet", prompted, "silent no-op");

  // And close it. Leaving the modal open would make every click below land on
  // an overlay — the loop would pass by testing nothing, which is how the last
  // two of these went wrong.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("wrong path: the wallet prompt closes again", (await page.locator("[data-rk] [role=dialog]").count()) === 0);

  for (const bad of ["abc", "-1", "0", "", "1e999", "  "]) {
    await fillByLabel("Lot (base units)", bad);
    await fillByLabel("Deadline block", bad);
    // Assert the field really took the value, so a fill that silently failed
    // cannot be mistaken for a form that handled it.
    const got = await page
      .locator("label", { hasText: "Lot (base units)" })
      .locator("input")
      .first()
      .inputValue();
    check(`wrong path: the lot field accepted ${JSON.stringify(bad)} as typed`, got === bad, `field holds ${JSON.stringify(got)}`);

    await action.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
    const text = (await page.textContent("body")) ?? "";
    check(
      `wrong path: no NaN on screen after posting ${JSON.stringify(bad)}`,
      !/NaN|undefined|Infinity/.test(text),
      text.slice(0, 60),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  check(
    "wrong path: bad form input raised no uncaught error",
    pageErrors.length === beforeForms,
    pageErrors.slice(beforeForms).join("; "),
  );
  // And the page is still usable afterwards, not wedged.
  check("wrong path: the desk is still standing", /BUTA/i.test((await page.textContent("body")) ?? ""));
}

// ---- everything behind the connect button -----------------------------------
//
// Up to here every wrong path ended at "connect a wallet", so the half of the
// desk that only exists once connected had never been run by anything but a
// person. qa/wallet.mjs injects a provider that signs in node and refuses to
// broadcast, which is enough to open it.
const connected = await connect(page, wallet);
check("happy path: the desk connects and shows the address", connected, `expected ${wallet}`);

if (connected) {
  // A cleared auction is closed to bids, and the first row usually is one — the
  // form only exists on a SEALED auction, so pick one of those.
  const sealed = page.locator("button", { hasText: /FXRP\// }).filter({ hasText: /SEALED/i }).first();
  check("there is a sealed auction to bid on", (await sealed.count()) > 0);
  if (await sealed.count()) {
    await sealed.click();
    await page.waitForTimeout(800);
  }
  const bidTab = page.locator("button", { hasText: /seal a bid/i }).first();
  if (await bidTab.count()) {
    await bidTab.click().catch(() => {});
    await page.waitForTimeout(600);
  }

  const bidField = page.locator("label", { hasText: /your bid/i }).locator("input").first();
  check("the bid form is reachable once connected", (await bidField.count()) > 0);

  if (await bidField.count()) {
    const seal = page.locator("button", { hasText: /^seal bid$/i }).first();
    const beforeBids = pageErrors.length;

    // The amount is parsed with BigInt. Anything that is not a whole number
    // throws, and the throw has to become a message rather than a dead button.
    for (const bad of ["abc", "1.5", "-3", "0", "", "1e9", "0x10", " 12 "]) {
      await bidField.fill(bad);
      await seal.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(700);
      const text = (await page.textContent("body")) ?? "";
      check(
        `wrong path: sealing ${JSON.stringify(bad)} says something`,
        /must be|cannot|invalid|failed|error|positive|whole/i.test(text),
        text.slice(0, 60),
      );
      check(
        `wrong path: sealing ${JSON.stringify(bad)} raised no uncaught error`,
        pageErrors.length === beforeBids,
        pageErrors.slice(beforeBids).join("; "),
      );
      check(`wrong path: no NaN after sealing ${JSON.stringify(bad)}`, !/NaN|undefined/.test(text));
    }

    // A well-formed bid. Against the deployed desk there is no enclave to seal
    // it, so the desk has to report that — not hang on a spinner and not claim
    // a bid was sealed. Against a live stack the opposite is the pass.
    await bidField.fill("130450");
    await seal.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(8000);
    const after = (await page.textContent("body")) ?? "";
    if (onDemo) {
      check(
        "wrong path: a valid bid with no reachable enclave reports the failure",
        /fail|could not|unreachable|error|offline|refus/i.test(after),
        after.slice(0, 80),
      );
      check(
        "wrong path: and it does not claim the bid was sealed",
        !/you are bid #/i.test(after),
        "the desk said a bid was sealed with no enclave to seal it",
      );
    } else {
      check(
        "happy path: a valid bid against a live enclave is sealed and receipted",
        /you are bid #/i.test(after) && /nonce/i.test(after),
        after.slice(0, 120),
      );
    }
    check(
      "wrong path: the button is not left spinning",
      (await seal.isEnabled().catch(() => true)) === true,
      "still busy after 6s",
    );
  }
}

// ---- wrong path: the desk must not phone home to a proxy it does not own ----
const foreign = requests.filter(
  (u) => /flare\.rocks|walletconnect|web3modal/i.test(u),
);
check(
  "wrong path: no requests to third-party or borrowed infrastructure",
  foreign.length === 0,
  [...new Set(foreign)].slice(0, 3).join(", "),
);

await browser.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
