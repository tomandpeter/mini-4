import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  toHex,
} from "viem";

const PROCESSOR_ABI = [
  {
    type: "function",
    name: "eval",
    stateMutability: "view",
    inputs: [
      { name: "circuitId", type: "uint256" },
      { name: "input", type: "bytes" },
    ],
    outputs: [{ name: "output", type: "bytes" }],
  },
];
const PROCESSOR_ADDRESS = "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C";
const FIXED_BLOCK_NUMBER = 117_056_298;
const FIXED_BLOCK_TAG = toHex(FIXED_BLOCK_NUMBER);
const MOCK_PROXY_CODE = `0x${"60".repeat(295)}`;
const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_MINI4_CHAIN_ID",
  "NEXT_PUBLIC_MINI4_RPC_URL",
  "NEXT_PUBLIC_MINI4_EXPLORER_URL",
  "NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS",
];

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

async function withEnvironment(overrides, callback) {
  const previous = Object.fromEntries(
    PUBLIC_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PUBLIC_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);

  try {
    return await callback();
  } finally {
    for (const key of PUBLIC_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function postCalculation(circuit, inputs) {
  return fetchApi("/api/calculate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ circuit, inputs }),
  });
}

async function startMockRpc({ code = MOCK_PROXY_CODE, resolveOutput }) {
  const requests = [];
  const state = { forcedOutput: undefined };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpcRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(rpcRequest);

    let result;
    if (rpcRequest.method === "eth_chainId") result = "0x38";
    if (rpcRequest.method === "eth_blockNumber") result = FIXED_BLOCK_TAG;
    if (rpcRequest.method === "eth_getCode") result = code;
    if (rpcRequest.method === "eth_call") {
      const decoded = decodeFunctionData({
        abi: PROCESSOR_ABI,
        data: rpcRequest.params[0].data,
      });
      const [circuitId, inputBytes] = decoded.args;
      const output = state.forcedOutput ?? resolveOutput(Number(circuitId), inputBytes);
      result = encodeFunctionResult({
        abi: PROCESSOR_ABI,
        functionName: "eval",
        result: output,
      });
    }

    response.writeHead(result === undefined ? 400 : 200, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify(
        result === undefined
          ? {
              jsonrpc: "2.0",
              id: rpcRequest.id,
              error: { code: -32601, message: "Method not found" },
            }
          : { jsonrpc: "2.0", id: rpcRequest.id, result },
      ),
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    requests,
    state,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function mockEnvironment(rpcUrl) {
  return {
    NEXT_PUBLIC_MINI4_CHAIN_ID: "56",
    NEXT_PUBLIC_MINI4_RPC_URL: rpcUrl,
    NEXT_PUBLIC_MINI4_EXPLORER_URL: "https://explorer.example",
    NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS: PROCESSOR_ADDRESS,
  };
}

test("blocks explicit missing configuration without claiming the chain is online", async () => {
  await withEnvironment(
    {
      NEXT_PUBLIC_MINI4_CHAIN_ID: "56",
      NEXT_PUBLIC_MINI4_RPC_URL: "",
      NEXT_PUBLIC_MINI4_EXPLORER_URL: "https://bscscan.com",
      NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS: "",
    },
    async () => {
      const statusResponse = await fetchApi("/api/status");
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.status, "blocked");
      assert.equal(status.chain.id, 56);
      assert.equal(status.chain.rpcConfigured, false);
      assert.equal(status.chain.online, null);
      assert.equal("blockNumber" in status, false);
      assert.equal(status.error.code, "CONFIGURATION_BLOCKED");
      assert.equal(status.circuits.length, 5);
      assert.equal(status.circuits.every(({ configured }) => !configured), true);
      assert.equal(status.circuits.every((circuit) => !("address" in circuit)), true);

      const calculationResponse = await postCalculation("halfAdder", [1, 1]);
      assert.equal(calculationResponse.status, 503);
      const calculation = await calculationResponse.json();
      assert.equal(calculation.ok, false);
      assert.equal(calculation.error.code, "CONFIGURATION_BLOCKED");
      assert.match(calculation.error.message, /local calculation is disabled/i);
      assert.equal("outputs" in calculation, false);
      assert.equal("evidence" in calculation, false);
    },
  );
});

test("rejects non-mainnet configuration before any RPC call", async () => {
  await withEnvironment(
    {
      NEXT_PUBLIC_MINI4_CHAIN_ID: "97",
      NEXT_PUBLIC_MINI4_RPC_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_MINI4_EXPLORER_URL: "https://testnet.bscscan.com",
      NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS: PROCESSOR_ADDRESS,
    },
    async () => {
      const statusResponse = await fetchApi("/api/status");
      const status = await statusResponse.json();
      assert.equal(status.status, "blocked");
      assert.equal(status.chain.id, null);
      assert.equal(status.chain.online, null);
      assert.match(status.error.message, /CHAIN_ID must be 56/);

      const calculationResponse = await postCalculation("nand", [0, 0]);
      assert.equal(calculationResponse.status, 503);
      assert.equal((await calculationResponse.json()).error.code, "CONFIGURATION_BLOCKED");
    },
  );
});

test("rejects unsupported circuits and non-bit inputs before chain access", async (t) => {
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
      assert.equal((await response.json()).error.code, testCase.code);
    });
  }
});

test("uses one deployed processor for the complete verified truth table", async () => {
  const truthTables = {
    1: [1, 1, 1, 0],
    2: [1, 0],
    3: [0, 0, 0, 1],
    4: [0, 1, 1, 0],
    5: [0, 1, 1, 2],
  };
  const circuits = [
    { key: "nand", id: 1 },
    { key: "not", id: 2 },
    { key: "and", id: 3 },
    { key: "xor", id: 4 },
    { key: "halfAdder", id: 5 },
  ];
  const rpc = await startMockRpc({
    resolveOutput(circuitId, inputBytes) {
      const output = truthTables[circuitId]?.[Number.parseInt(inputBytes.slice(2), 16)];
      assert.notEqual(output, undefined, "mock received an unsupported circuit/input");
      return toHex(output, { size: 1 });
    },
  });

  try {
    await withEnvironment(mockEnvironment(rpc.url), async () => {
      const statusResponse = await fetchApi("/api/status");
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.status, "ready");
      assert.equal(status.chain.id, 56);
      assert.equal(status.chain.online, true);
      assert.equal(status.blockNumber, String(FIXED_BLOCK_NUMBER));
      assert.equal(status.circuits.every(({ configured }) => configured), true);
      assert.deepEqual(
        [...new Set(status.circuits.map(({ address }) => address))],
        [PROCESSOR_ADDRESS],
      );

      for (const circuit of circuits) {
        const table = truthTables[circuit.id];
        for (let packedInput = 0; packedInput < table.length; packedInput += 1) {
          const inputs =
            circuit.key === "not"
              ? [packedInput & 1]
              : [packedInput & 1, (packedInput >> 1) & 1];
          const response = await postCalculation(circuit.key, inputs);
          assert.equal(response.status, 200, `${circuit.key} input ${packedInput}`);
          const payload = await response.json();
          const expectedByte = table[packedInput];

          assert.equal(payload.ok, true);
          assert.deepEqual(payload.inputs, inputs);
          if (circuit.key === "halfAdder") {
            assert.deepEqual(payload.outputs, {
              sum: expectedByte & 1,
              carry: (expectedByte >> 1) & 1,
              binary: `${(expectedByte >> 1) & 1}${expectedByte & 1}`,
              decimal: expectedByte,
            });
          } else {
            assert.deepEqual(payload.outputs, { result: expectedByte });
          }

          const expectedCalldata = encodeFunctionData({
            abi: PROCESSOR_ABI,
            functionName: "eval",
            args: [BigInt(circuit.id), toHex(packedInput, { size: 1 })],
          });
          const expectedRawResult = encodeFunctionResult({
            abi: PROCESSOR_ABI,
            functionName: "eval",
            result: toHex(expectedByte, { size: 1 }),
          });
          assert.equal(payload.evidence.chainId, 56);
          assert.equal(payload.evidence.blockNumber, String(FIXED_BLOCK_NUMBER));
          assert.equal(payload.evidence.address, PROCESSOR_ADDRESS);
          assert.equal(payload.evidence.calldata, expectedCalldata);
          assert.equal(payload.evidence.rawResult, expectedRawResult);
          assert.equal(
            payload.evidence.explorerUrl,
            `https://explorer.example/address/${PROCESSOR_ADDRESS}`,
          );
        }
      }

      const codeRequests = rpc.requests.filter(({ method }) => method === "eth_getCode");
      const callRequests = rpc.requests.filter(({ method }) => method === "eth_call");
      assert.equal(codeRequests.length, 19);
      assert.equal(callRequests.length, 18);
      assert.equal(
        codeRequests.every(({ params }) => params[1] === FIXED_BLOCK_TAG),
        true,
      );
      assert.equal(
        callRequests.every(({ params }) => params[1] === FIXED_BLOCK_TAG),
        true,
      );
      assert.equal(
        callRequests.every(({ params }) => params[0].to === PROCESSOR_ADDRESS),
        true,
      );
    });
  } finally {
    await rpc.close();
  }
});

test("rejects non-single-byte and unused-bit processor outputs", async () => {
  const rpc = await startMockRpc({
    resolveOutput() {
      return "0x00";
    },
  });

  try {
    await withEnvironment(mockEnvironment(rpc.url), async () => {
      const cases = [
        { circuit: "nand", inputs: [0, 0], output: "0x0001" },
        { circuit: "xor", inputs: [1, 0], output: "0x02" },
        { circuit: "halfAdder", inputs: [1, 1], output: "0x04" },
        { circuit: "halfAdder", inputs: [1, 1], output: "0x03" },
      ];

      for (const testCase of cases) {
        rpc.state.forcedOutput = testCase.output;
        const response = await postCalculation(testCase.circuit, testCase.inputs);
        assert.equal(response.status, 502);
        const payload = await response.json();
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, "INVALID_CONTRACT_RESPONSE");
        assert.equal("outputs" in payload, false);
        assert.equal("evidence" in payload, false);
      }
    });
  } finally {
    await rpc.close();
  }
});

test("does not report ready or call eval when the processor address has no code", async () => {
  const rpc = await startMockRpc({
    code: "0x",
    resolveOutput() {
      return "0x00";
    },
  });

  try {
    await withEnvironment(mockEnvironment(rpc.url), async () => {
      const statusResponse = await fetchApi("/api/status");
      const status = await statusResponse.json();
      assert.equal(status.status, "degraded");
      assert.equal(status.chain.online, false);
      assert.equal(status.error.code, "PROCESSOR_CODE_MISSING");
      assert.equal(status.circuits.every(({ configured }) => configured), true);

      const response = await postCalculation("halfAdder", [1, 1]);
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error.code, "PROCESSOR_CODE_MISSING");
      assert.equal("outputs" in payload, false);
      assert.equal(rpc.requests.some(({ method }) => method === "eth_call"), false);
    });
  } finally {
    await rpc.close();
  }
});
