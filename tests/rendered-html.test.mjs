import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(path, "http://localhost/"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the MINI-4 product instead of the starter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MINI-4 — A Calculator Built On-Chain<\/title>/i);
  assert.match(html, /A calculator/);
  assert.match(html, /built on-chain\./);
  assert.match(html, /Decimal calculator/);
  assert.match(html, /1-BIT MODE/);
  assert.match(html, /CHAIN RESULT/);
  assert.match(html, /NO GAS FEE/);
  assert.match(html, /Calculator keypad/);
  assert.match(html, /Keys 2–9 are disabled\. They need a future 8-bit adder\./);
  assert.match(html, /Equals, calculate on-chain/);
  assert.match(html, /<small>ON-CHAIN<\/small>/);
  assert.match(html, /No chain result yet\. This screen never substitutes browser arithmetic\./);
  assert.match(html, /A normal calculator vs\. MINI-4\./);
  assert.match(html, /processor address, block, calldata, and raw result/i);
  assert.match(html, /upgradeable beacon proxy/i);
  assert.match(html, /Logic Lab/);
  assert.match(html, /CHECKING PROCESSOR/);
  assert.match(html, /aria-live="polite"/);
  for (const digit of [2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.match(
      html,
      new RegExp(
        `<button(?=[^>]*disabled)(?=[^>]*aria-label="${digit}, unavailable until a future 8-bit adder")[^>]*>\\s*${digit}\\s*</button>`,
        "i",
      ),
    );
  }
  assert.match(
    html,
    /<button(?=[^>]*disabled)(?=[^>]*aria-label="Equals, calculate on-chain")[^>]*>/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
  assert.doesNotMatch(html, /ADD ON-CHAIN|Computed by Circuit #5 at block/);
});

test("keeps the decimal display chained to the API response", async () => {
  const source = await readFile(
    new URL("../app/Mini4Lab.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /adderResult\?\.outputs\.decimal \?\? "—"/);
  assert.match(source, /ready && circuit\.configured/);
  assert.match(source, /nestedControl\?\.classList\.contains\("text-button"\)/);
  assert.doesNotMatch(source, /adderA\s*\+\s*adderB/);
  assert.doesNotMatch(source, /event\.target !== event\.currentTarget/);
  assert.doesNotMatch(source, /local(?:Result|Fallback)|browserResult/i);
});

test("publishes site-specific social metadata", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:site_name" content="MINI-4"/i);
  assert.match(
    html,
    /property="og:image" content="http:\/\/localhost:3000\/og\.png"/i,
  );
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /MINI-4 decimal-style 1-bit on-chain calculator/i);
});
