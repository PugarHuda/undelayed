/**
 * A wallet for the flow checks.
 *
 * Every desk wrong-path stopped at "connect a wallet", which meant the half of
 * the app behind the connect button had never been exercised by anything but a
 * human. This injects an EIP-1193 provider so Playwright can get past it.
 *
 * The provider in the page holds no key. It forwards every call to node over
 * one exposed function; signing happens there with viem, reads go to the public
 * Coston2 RPC. Nothing is funded and nothing is broadcast — `eth_sendTransaction`
 * refuses on purpose, because a check that spends real gas is a check nobody
 * runs twice.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { flareTestnet } from "viem/chains";

/** A published test key. It holds nothing, and it must stay that way. */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const CHAIN_ID = 114;

/**
 * Installs the wallet on a Playwright context. Call before the first goto —
 * the page reads window.ethereum on load.
 */
export async function installWallet(ctx, { chainId = CHAIN_ID, rpc = RPC, privateKey, broadcast = false } = {}) {
  const account = privateKeyToAccount(privateKey ?? TEST_KEY);

  // Opt-in, and only ever from a one-off driver — never from a suite. A check
  // that spends real gas is a check nobody runs twice, which is the same as no
  // check at all. scripts/settle-from-browser.mjs turns this on deliberately
  // because the thing it proves cannot be proved any other way: that the DESK
  // can settle, not just the script that shares its libraries.
  const sender = broadcast
    ? createWalletClient({ account, chain: { ...flareTestnet, id: chainId }, transport: http(rpc) })
    : null;

  await ctx.exposeFunction("__wallet", async (method, params = []) => {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "net_version":
        return String(chainId);
      case "personal_sign":
        // MetaMask's order is [message, address]. The message arrives as hex.
        return account.signMessage({ message: { raw: params[0] } });
      case "eth_signTypedData_v4":
        return account.signTypedData(JSON.parse(params[1]));
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction": {
        // Deliberate. See the note at the top of the file.
        if (!sender) throw new Error("test wallet does not broadcast");
        const t = params[0] ?? {};
        const big = (v) => (v === undefined || v === null ? undefined : BigInt(v));
        return sender.sendTransaction({
          to: t.to, data: t.data, value: big(t.value), gas: big(t.gas),
        });
      }
      default: {
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message ?? "rpc error");
        return j.result;
      }
    }
  });

  await ctx.addInitScript(() => {
    const listeners = {};
    const provider = {
      isMetaMask: true,
      request: ({ method, params }) => window.__wallet(method, params ?? []),
      on: (ev, fn) => ((listeners[ev] ??= []).push(fn), provider),
      removeListener: (ev, fn) => {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return provider;
      },
    };
    window.ethereum = provider;

    // RainbowKit v2 discovers wallets by EIP-6963 first and only falls back to
    // window.ethereum. Announcing here is what makes it appear in the list.
    const detail = Object.freeze({
      info: {
        uuid: "00000000-0000-4000-8000-000000000001",
        name: "Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        rdns: "qa.test.wallet",
      },
      provider,
    });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });

  return account.address;
}

/**
 * Clicks through RainbowKit's modal. Returns true once the page shows the
 * address — a connect that silently did nothing is the failure this catches.
 */
export async function connect(page, address) {
  // The address is shown truncated (0x70…79C8), so the tail is what identifies
  // it. Matching the head would fail on exactly the state we are checking for.
  const tail = address.slice(-4).toLowerCase();
  const shown = async () => ((await page.textContent("body")) ?? "").toLowerCase().includes(tail);

  // wagmi reconnects to an injected wallet on load, so by the time the page is
  // idle there is usually nothing left to click. Treat that as connected rather
  // than hunting for a button that is not there.
  if (await shown()) return true;

  const btn = page.locator("button", { hasText: /connect wallet/i }).first();
  if (!(await btn.count())) return false;
  await btn.click();
  await page.waitForTimeout(800);

  const entry = page.locator("[data-rk] button", { hasText: /test wallet|browser wallet|injected/i }).first();
  if (await entry.count()) {
    await entry.click();
    await page.waitForTimeout(1500);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  return shown();
}
