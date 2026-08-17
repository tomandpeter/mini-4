import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { toFunctionSelector } from "viem";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("chain-api-test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const workerEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function fetchApi(path, init) {
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    workerEnv,
    workerContext,
  );
}

test("reports a blocked status without pretending the chain is online", async () => {
  const response = await fetchApi("/api/status");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);

  const payload = await response.json();
  assert.equal(payload.status, "blocked");
  assert.equal(payload.chain.id, 56);
  assert.equal(payload.chain.rpcConfigured, false);
  assert.equal(payload.chain.online, null);
  assert.equal("blockNumber" in payload, false);
  assert.equal(payload.error.code, "CONFIGURATION_BLOCKED");
  assert.deepEqual(
    payload.circuits.map(({ key, number, configured }) => ({ key, number, configured })),
    [
      { key: "nand", number: 1, configured: false },
      { key: "not", number: 2, configured: false },
      { key: "and", number: 3, configured: false },
      { key: "xor", number: 4, configured: false },
      { key: "halfAdder", number: 5, configured: false },
    ],
  );
});

test("refuses to fabricate a half-adder result when contracts are not configured", async () => {
  const response = await fetchApi("/api/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ circuit: "halfAdder", inputs: [1, 1] }),
  });
  assert.equal(response.status, 503);

  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "CONFIGURATION_BLOCKED");
  assert.match(payload.error.message, /local calculation is disabled/i);
  assert.equal("outputs" in payload, false);
  assert.equal("evidence" in payload, false);
});

test("rejects unsupported circuits and non-bit inputs before configuration checks", async (t) => {
  const cases = [
    {
      name: "unknown circuit",
      body: { circuit: "or", inputs: [0, 1] },
      code: "INVALID_CIRCUIT",
    },
    {
      name: "integer outside one bit",
      body: { circuit: "xor", inputs: [0, 2] },
      code: "INVALID_INPUT",
    },
    {
      name: "string is not a numeric bit",
      body: { circuit: "nand", inputs: ["0", 1] },
      code: "INVALID_INPUT",
    },
    {
      name: "NOT accepts exactly one input",
      body: { circuit: "not", inputs: [1, 0] },
      code: "INVALID_INPUT",
    },
    {
      name: "unexpected fields are rejected",
      body: { circuit: "and", inputs: [1, 1], localResult: 1 },
      code: "INVALID_REQUEST",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const response = await fetchApi("/api/calculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testCase.body),
      });
      assert.equal(response.status, 400);
      assert.deepEqual((await response.json()).error.code, testCase.code);
    });
  }
});

test("returns half-adder display values only after a valid eth_call response", async () => {
  const rpcRequests = [];
  const zeroWord = "0".repeat(64);
  const oneWord = `${"0".repeat(63)}1`;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpcRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    rpcRequests.push(rpcRequest);

    const results = {
      eth_chainId: "0x38",
      eth_blockNumber: "0x1234",
      eth_call: `0x${zeroWord}${oneWord}`,
    };
    const result = results[rpcRequest.method];
    response.writeHead(result ? 200 : 400, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        result
          ? { jsonrpc: "2.0", id: rpcRequest.id, result }
          : {
              jsonrpc: "2.0",
              id: rpcRequest.id,
              error: { code: -32601, message: "Method not found" },
            },
      ),
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const configuredEnvironment = {
    NEXT_PUBLIC_MINI4_CHAIN_ID: "56",
    NEXT_PUBLIC_MINI4_RPC_URL: `http://127.0.0.1:${address.port}`,
    NEXT_PUBLIC_MINI4_EXPLORER_URL: "https://explorer.example",
    NEXT_PUBLIC_MINI4_NAND_ADDRESS: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MINI4_NOT_ADDRESS: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MINI4_AND_ADDRESS: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MINI4_XOR_ADDRESS: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MINI4_HALF_ADDER_ADDRESS: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MINI4_HALF_ADDER_SIGNATURE: "sumBits(uint8,bool)",
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(configuredEnvironment).map((key) => [key, process.env[key]]),
  );

  Object.assign(process.env, configuredEnvironment);
  try {
    const statusResponse = await fetchApi("/api/status");
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.status, "ready");
    assert.equal(statusPayload.chain.online, true);
    assert.equal(statusPayload.blockNumber, "4660");
    assert.equal(statusPayload.circuits.every(({ configured }) => configured), true);

    const response = await fetchApi("/api/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ circuit: "halfAdder", inputs: [1, 1] }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.inputs, [1, 1]);
    assert.deepEqual(payload.outputs, {
      sum: 0,
      carry: 1,
      binary: "10",
      decimal: 2,
    });
    assert.equal(payload.evidence.chainId, 56);
    assert.equal(payload.evidence.blockNumber, "4660");
    assert.equal(
      payload.evidence.explorerUrl,
      "https://explorer.example/address/0x1111111111111111111111111111111111111111",
    );
    assert.equal(payload.evidence.rawResult, `0x${zeroWord}${oneWord}`);

    const callRequest = rpcRequests.find(({ method }) => method === "eth_call");
    assert.ok(callRequest, "expected an eth_call request");
    assert.equal(callRequest.params[1], "0x1234");
    assert.equal(callRequest.params[0].to, configuredEnvironment.NEXT_PUBLIC_MINI4_HALF_ADDER_ADDRESS);
    assert.equal(
      callRequest.params[0].data,
      `${toFunctionSelector("sumBits(uint8,bool)")}${oneWord}${oneWord}`,
    );
    assert.equal(payload.evidence.calldata, callRequest.params[0].data);
  } finally {
    for (const key of Object.keys(configuredEnvironment)) {
      const previousValue = previousEnvironment[key];
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
    server.close();
    await once(server, "close");
  }
});
