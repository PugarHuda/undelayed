/**
 * Flow checks for the Buta desk.
 *
 *   node qa/flows-desk.mjs [url]        default: https://buta-desk.vercel.app/dashboard
 *
 * Runs against either kind of desk and checks the one it found.
 *
 * The deployed desk has no backend a browser can reach, so its happy path is
 * the honest-offline one: it says the book is a demo, shows it anyway, and
 * every control that cannot work says so instead of pretending. That is worth
 * checking precisely BECAUSE it is the fallback — a judge opening the link sees
 * this and nothing else, and a fallback nobody exercises quietly rots.
 *
 * Build the static bundle with VITE_TEE_PROXY_URL= — .env.local otherwise bakes
 * a localhost proxy into it, which is not what deploys, and which silently
 * turned the no-polling check off on every local run.
 *
 * Point it at a local stack and the live branches run instead: a bid really is
 * sealed, the receipt really is kept, and the disclosure form really is filled
 * from it. Which branch applies is decided by whether an enclave answered, not
 * by what the page says about itself.
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
// Responses too: whether an enclave answered is the only honest way to know if
// this desk is live, and the page saying so is not evidence of it.
const replies = [];
page.on("response", (r) => replies.push({ url: r.url(), ok: r.ok() }));

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
await page.waitForTimeout(5000);

const body = (await page.textContent("body")) ?? "";

// Whether this desk has a backend behind it — decided by whether an enclave
// actually answered, not by whether the page says so. Reading it off the banner
// made the banner check a tautology: the desk was asked to admit it was on demo
// data, and the evidence for the question was the admission itself.
const liveBackend = replies.some((r) => /\/direct$/.test(r.url) && r.ok);
const onDemo = !liveBackend;

// Now it can be checked in both directions. A desk with no enclave must say the
// book is a demo; a desk with one must not.
check(
  onDemo ? "desk admits the book is a demo when nothing answered" : "desk does not cry demo while an enclave is answering",
  onDemo === /demo book/i.test(body),
  `banner ${/demo book/i.test(body) ? "shown" : "absent"}, backend ${liveBackend ? "live" : "unreachable"}`,
);

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
// Only the offline desk needs to say this, and only the offline desk can — the
// line lives in the demo banner. Asserting it against a live stack fails for
// the desk being live.
if (onDemo) check("desk says how to get the live flow", /go run \.\/cmd\/dev/i.test(body));

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

// A deadline is a block number, which is not a time to anyone. The desk reads
// the chain's head and says what it means — and the clearing control used to
// ask "Past the deadline?", a question it was in a position to answer.
check(
  "a deadline is expressed as time, not only as a block number",
  /left\b|deadline passed/i.test(body),
  "no countdown anywhere on the page",
);
check(
  "the desk no longer asks the reader whether the deadline has passed",
  !/past the deadline\?/i.test(body),
  "still asking",
);
check(
  "and it states which side of the deadline this auction is on",
  /can be cleared now|not until block/i.test(body),
  body.slice(0, 60),
);
check(
  "posting is offered without a selection",
  (await page.locator("button", { hasText: /post a block/i }).count()) > 0,
);
// Every panel names itself. A screen that opens with a table and no heading
// makes the reader work out where they are from the contents.
check("the book says what it is", /open blocks/i.test(body));
check(
  "the bid form lists what has to be true before anything is sealed",
  /before it leaves this browser/i.test(body),
  "no preconditions shown",
);
check(
  "and it says the commitment is computed here rather than sent",
  /computed here, not sent/i.test(body),
);

// Clearing has two rails too, and only one of them can end in a settlement.
// The direct channel is refused by a production stack and its facade signs
// nothing, so a clearing taken that way is one relayClearing will never accept.
check(
  "a clearing can be requested on-chain, not only over the demo channel",
  /request clearing on-chain/i.test(body),
  "no on-chain clearing offered",
);
check(
  "and the desk says why only a signed one can be settled",
  /only a signed one can be settled/i.test(body),
  "no reason given",
);

// Both rails for a bid, not just the demo one. The direct channel records the
// commitment in enclave memory; only a commitBid transaction puts it in the set
// relayClearing checks a clearing against, so a bid that never reached the chain
// can demonstrate the mechanism but never complete a settlement.
check(
  "a bid can be sealed on-chain, not only over the demo channel",
  /seal on-chain instead/i.test(body),
  "only the direct rail is offered for bidding",
);
check(
  "and it says why that rail is the one that counts",
  /set the clearing has to match/i.test(body),
  "no reason given for choosing it",
);

// Every receipt the desk hands back used to overwrite the previous one, so
// clearing an auction erased the outcome of the last one you cleared. They are
// kept now, and the panel exists whether or not anything has happened yet.
const activityTab = page.locator("button", { hasText: /^▸? ?activity$/i }).first();
check("there is somewhere the session's receipts are kept", (await activityTab.count()) > 0);
if (await activityTab.count()) {
  await activityTab.click();
  await page.waitForTimeout(600);
  const act = (await page.textContent("body")) ?? "";
  check("the activity panel names itself", /this session/i.test(act), act.slice(0, 60));
  check(
    "and an empty one says what would fill it",
    /nothing yet|post a block|seal a bid/i.test(act),
    "empty with no explanation",
  );
}

// ---- the address every on-chain action goes to ------------------------------
//
// It was a constant, and it stayed at the FIRST of four deployments while three
// later ones were live. A stale address does not throw: it reverts every
// transaction against a contract nothing is bound to any more. The desk asks the
// diamond now, so this checks the desk agrees with the chain rather than with
// whatever was typed into it.
{
  const auditTab = page.locator("button", { hasText: /^▸? ?audit$/i }).first();
  if (await auditTab.count()) {
    await auditTab.click();
    await page.waitForTimeout(2500);
    const shown = ((await page.textContent("body")) ?? "").match(/0x[0-9a-fA-F]{40}/g) ?? [];
    // Read from NODE, not from the page. Doing it in the browser meant a CORS
    // failure returned null, and `!live ||` then passed the check — putting the
    // stale constant back left it green, which is the whole thing it exists to
    // catch. Here a failed read is a failed check.
    const live = await (async () => {
      const r = await fetch("https://coston2-api.flare.network/ext/C/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{
            to: "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
            // getTeeExtensionInstructionsSender(uint256), extension 65642.
            // Computed with toFunctionSelector, not guessed — a guessed one
            // returns 0x and this check would pass on nothing.
            data: "0x2c177358" + (65642).toString(16).padStart(64, "0"),
          }, "latest"],
        }),
      }).catch(() => null);
      if (!r?.ok) return null;
      const j = await r.json();
      return j.result && j.result !== "0x" ? "0x" + j.result.slice(-40) : null;
    })();
    check(
      "the desk's Audit panel names the contract the diamond is actually bound to",
      !!live && shown.some((a) => a.toLowerCase() === live.toLowerCase()),
      `diamond says ${live}, panel shows ${shown.slice(0, 4).join(", ")}`,
    );
  }
  // Back to the book — everything after this needs rows.
  const bookTab = page.locator("button", { hasText: /^▸? ?book$/i }).first();
  if (await bookTab.count()) {
    await bookTab.click();
    await page.waitForTimeout(500);
  }
  check("and the book is still there afterwards", (await page.locator("button", { hasText: /FXRP\// }).count()) > 0);
}

// ---- wrong path: a cleared auction offers a way on, not a dead end ----------
const clearedRow = page.locator("button", { hasText: /FXRP\// }).filter({ hasText: /CLEARED/i }).first();
if (await clearedRow.count()) {
  await clearedRow.click();
  await page.waitForTimeout(700);
  const onCleared = (await page.textContent("body")) ?? "";
  // A cleared row opens its receipt under itself. The second price is public —
  // Vickrey pays it — and the row has to say what stayed sealed, or the reader
  // has no way to tell a private auction from a merely quiet one.
  check("a cleared auction opens its receipt", /clearing price/i.test(onCleared), onCleared.slice(0, 80));
  check("the receipt names the second price as the rule", /vickrey second price/i.test(onCleared));
  check("and says what stayed sealed", /sealed forever/i.test(onCleared));
  // "3 bids" is a number you take on trust. The commitments are public by
  // construction — the contract records each one before anyone knows what is in
  // it — so the receipt lists them. That list is the claim made visible, and it
  // is the first thing that would quietly vanish if the field stopped arriving.
  check(
    "the receipt lists the sealed bids, not just how many",
    // No \b after the digit: the commitment follows it immediately once the
    // markup is flattened to text, and "1f" has no word boundary in it.
    /bid 1/i.test(onCleared),
    "no commitment list in the receipt",
  );
  check(
    "and no amount is printed beside any of them",
    !/amount[^s]*[:=]\s*\d/i.test(onCleared),
    onCleared.slice(0, 60),
  );
}

// ---- happy path: selecting an auction opens it ------------------------------
//
// The SECOND row, not the first. The desk opens with the first open auction
// already selected, so clicking that one changes nothing and the check passed
// or failed on the accident of which auction happened to be on top.
const rowLocator = page.locator("button", { hasText: /FXRP\// });
const rowTotal = await rowLocator.count();
const target = rowLocator.nth(rowTotal > 1 ? 1 : 0);
const beforeSelect = (await page.textContent("body")) ?? "";
await target.click();
await page.waitForTimeout(800);
const afterSelect = (await page.textContent("body")) ?? "";
check("selecting a different auction changes the page", afterSelect !== beforeSelect, `${rowTotal} rows`);

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
  // The form offers both shapes of the product. An invited auction with one
  // sealed bid IS a bilateral settle — same commitment, same digest — and the
  // UI used to hide that as an optional field below the deadline.
  const formText = (await page.textContent("body")) ?? "";
  check(
    "the post form offers both ways to clear",
    /open auction/i.test(formText) && /one counterparty/i.test(formText),
    "only one shape offered",
  );
  check(
    "the counterparty field appears only when it is needed",
    (await page.locator("label", { hasText: /^the counterparty/i }).count()) === 0,
    "asking for a counterparty on an open auction",
  );
  const bilateralCard = page.locator("button", { hasText: /one counterparty/i }).first();
  if (await bilateralCard.count()) {
    await bilateralCard.click();
    await page.waitForTimeout(400);
    check(
      "choosing a counterparty asks for one",
      (await page.locator("label", { hasText: /^the counterparty/i }).count()) > 0,
    );
    await page.locator("button", { hasText: /open auction/i }).first().click().catch(() => {});
    await page.waitForTimeout(400);
  }

  // The deadline is asked in minutes and shown as the block it becomes. It used
  // to ask for the block directly, with a placeholder nine million blocks behind
  // the chain — anyone following the example posted an auction whose deadline
  // had already passed.
  // A block posted with no reserve gives the lot away: clearing floors AT the
  // reserve, so a single bid takes it for nothing. The field was optional and
  // said nothing about that — this is the check that it now refuses.
  await fillByLabel("Hidden reserve (quote units)", "");
  await page.locator("button", { hasText: /^post block$/i }).last().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(900);
  check(
    "wrong path: a block with no reserve is refused, and says why",
    /gives the lot away|reserve above zero/i.test((await page.textContent("body")) ?? ""),
    "posted with a zero floor without a word",
  );
  await fillByLabel("Hidden reserve (quote units)", "90000");

  check(
    "the deadline is asked in minutes and shown as the block it becomes",
    /open for \(minutes\)/i.test(formText) && /deadline is block/i.test(formText),
    "no minutes-to-block conversion shown",
  );

  // Two rails. The direct one is the demo path; on-chain is a transaction that
  // escrows the lot, and only that one makes the commitment set the clearing
  // has to match. The form offered no choice at all.
  check(
    "the form offers both rails",
    /direct \(demo\)/i.test(formText) && /on-chain/i.test(formText),
    "only one rail offered",
  );
  check(
    "and says what the direct one does not do",
    /nothing is escrowed/i.test(formText),
    "the demo rail does not admit it escrows nothing",
  );
  const chainRail = page.locator("button", { hasText: /^on-chain$/i }).first();
  if (await chainRail.count()) {
    await chainRail.click();
    await page.waitForTimeout(400);
    const onChainText = (await page.textContent("body")) ?? "";
    check(
      "picking the on-chain rail says what it will cost you",
      /escrowed/i.test(onChainText) && /approval/i.test(onChainText),
      "no mention of escrow or approval",
    );
    // Back to direct: the garbage-input loop below posts, and a transaction
    // prompt is not what it is testing.
    await page.locator("button", { hasText: /direct \(demo\)/i }).first().click().catch(() => {});
    await page.waitForTimeout(300);
  }

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

  // A post that SUCCEEDS closes the form and goes back to the book — which is
  // right, and which the loop below did not expect. Against a live enclave the
  // first click really does post, so the form has to be reopened before each
  // attempt rather than assumed to still be sitting there.
  const ensurePostForm = async () => {
    if (await page.locator("label", { hasText: "Lot (base units)" }).count()) return;
    const b = page.locator("button", { hasText: /post a block/i }).first();
    if (await b.count()) {
      await b.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  };

  for (const bad of ["abc", "-1", "0", "", "1e999", "  "]) {
    await ensurePostForm();
    await fillByLabel("Lot (base units)", bad);
    await fillByLabel("Open for (minutes)", bad);
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

// The button loop above walks the sidebar too, so it ends up wherever the last
// nav item it clicked leads — Audit, as it happens, where there is no book at
// all. Everything below needs rows, so navigate back deliberately rather than
// assuming a click loop left the desk somewhere useful.
for (const label of [/^▸? ?book$/i, /^all$/i]) {
  const b = page.locator("button", { hasText: label }).first();
  if (await b.count()) {
    await b.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}
check(
  "the book is reachable again after wandering the sidebar",
  (await page.locator("button", { hasText: /FXRP\// }).count()) > 0,
  "no rows after going back to Book / All",
);

if (connected) {
  // A cleared auction is closed to bids, and the first row usually is one — the
  // form only exists on a SEALED auction, so pick one of those. And not one
  // this wallet has already bid on: the enclave accepts one bid per address, so
  // running the suite twice against the same stack would otherwise fail on the
  // second run for being correct.
  const sealed = page
    .locator("button", { hasText: /FXRP\// })
    .filter({ hasText: /SEALED/i })
    .filter({ hasNotText: /BID SEALED/i })
    .first();
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
    // " 12 " was in this list and does not belong: the desk trims before it
    // parses, so a padded number is a VALID bid — and it sealed one, which made
    // the honest bid below the second from this address and correctly refused.
    // A wrong-path list with a right-path value in it does not just under-test,
    // it breaks the checks that come after.
    for (const bad of ["abc", "1.5", "-3", "0", "", "1e9", "0x10", "  ", "12.0"]) {
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
        (after.match(/>>>[^]{0,150}/) || [after.slice(0, 120)])[0],
      );
    }
    // Selective disclosure is the sharpest thing the desk does, and it was
    // unusable: building one needs the amount and the 32-byte nonce from the
    // moment you sealed, and the desk showed them once in a panel that vanished
    // on the next render. Sealing has to leave something behind that Portfolio
    // can offer back, or the feature exists only on paper.
    if (!onDemo) {
      const folioTab = page.locator("button", { hasText: /^▸? ?portfolio$/i }).first();
      if (await folioTab.count()) {
        await folioTab.click();
        await page.waitForTimeout(1200);
        const folio = (await page.textContent("body")) ?? "";
        check(
          "sealing left a receipt Portfolio can use",
          /your seals, kept in this browser/i.test(folio),
          "no stored seals after sealing a bid",
        );
        check(
          "and it says plainly where they are kept",
          /in this browser/i.test(folio) && /forget them/i.test(folio),
          "stored a secret without saying so or offering to drop it",
        );
        // One click has to fill the disclosure form — that is the whole point.
        const use = page.locator("button", { hasText: /use this/i }).first();
        if (await use.count()) {
          await use.click();
          await page.waitForTimeout(500);
          const nonceField = page.locator("label", { hasText: /nonce/i }).locator("input").first();
          const filled = (await nonceField.inputValue().catch(() => "")) || "";
          check(
            "picking a seal fills the nonce, so nobody has to copy 32 bytes by hand",
            /^0x[0-9a-f]{64}$/i.test(filled),
            `nonce field holds ${JSON.stringify(filled.slice(0, 20))}`,
          );

          // The whole point of the product, driven once: build a disclosure and
          // verify it. Nothing had ever run this, and it did not work — an
          // honest disclosure came back NOT VERIFIED.
          const verdictText = async () =>
            (await page.evaluate(() =>
              [...document.querySelectorAll("span")]
                .map((s) => (s.textContent || "").trim())
                .find((t) => /^VERIFIED|^NOT VERIFIED/.test(t)) ?? "",
            )) || "";

          await page.locator("button", { hasText: /build disclosure/i }).first().click().catch(() => {});
          await page.waitForTimeout(700);
          const proof = await page.locator("textarea").first().inputValue().catch(() => "");
          check("a disclosure is built from the seal", proof.trim().startsWith("{"), proof.slice(0, 60));

          await page.locator("button", { hasText: /^verify$/i }).first().click().catch(() => {});
          await page.waitForTimeout(4500);
          const honest = await verdictText();
          check("an honest disclosure verifies", /^VERIFIED/.test(honest), honest.slice(0, 90));
          check(
            "and the verdict names the amount it proved",
            /\d/.test(honest),
            "verified without saying what was proved",
          );

          // Tampered: the same nonce with a different amount produces a
          // different commitment, so the discloser cannot lie about their bid.
          if (proof.trim().startsWith("{")) {
            await page.locator("textarea").first().fill(proof.replace(/"amount":"\d+"/, '"amount":"999999999"'));
            await page.locator("button", { hasText: /^verify$/i }).first().click().catch(() => {});
            await page.waitForTimeout(4500);
            const lied = await verdictText();
            check("a tampered disclosure does not", /^NOT VERIFIED/.test(lied), lied.slice(0, 90));
          }
        }
        const bookTab = page.locator("button", { hasText: /^▸? ?book$/i }).first();
        if (await bookTab.count()) {
          await bookTab.click();
          await page.waitForTimeout(500);
        }
      }
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

// ---- wrong path: a wallet on the wrong network ------------------------------
//
// The bid signature is domain-separated by chain id. A wallet on any other
// network signs a payload the enclave cannot match, so the bid comes back
// rejected as a forged sender — and the connect button hides the network, so
// the failure reads as the desk being broken. The desk signed a hardcoded 114
// regardless, which made this silent in both directions.
//
// A second context, because the wallet's chain is fixed when it is installed.
{
  const other = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const wrongWallet = await installWallet(other, { chainId: 1 });
  const wrongPage = await other.newPage();
  await wrongPage.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await wrongPage.waitForTimeout(5000);
  await connect(wrongPage, wrongWallet);
  await wrongPage.waitForTimeout(800);
  const text = (await wrongPage.textContent("body")) ?? "";
  check(
    "wrong path: a wallet on another chain is told so before it bids",
    /not coston2/i.test(text),
    text.slice(0, 80),
  );
  check(
    "wrong path: and the desk names the chain it is actually on",
    /chain 1\b/.test(text),
    "did not say which chain the wallet is on",
  );
  await other.close();
}

await browser.close();

console.log(`\n${checks} checks, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
