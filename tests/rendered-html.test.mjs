import assert from "node:assert/strict";
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
  assert.match(html, /ADD ON-CHAIN/);
  assert.match(html, /Logic Lab/);
  assert.match(html, /No result is precomputed in this interface\./);
  assert.match(html, /CHECKING CHAIN/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<button[^>]+disabled[^>]*>[^<]*<span>ADD ON-CHAIN<\/span>/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
  assert.doesNotMatch(html, /Computed by Circuit #5 at block/);
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
  assert.match(html, /MINI-4 1-bit on-chain half-adder instrument/i);
});
