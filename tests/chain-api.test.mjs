import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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
  {
    type: "function",
    name: "circuitInfo",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "nIn", type: "uint32" },
      { name: "nOut", type: "uint32" },
      { name: "nState", type: "uint32" },
      { name: "gateCount", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "netlist",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "nl", type: "bytes" }],
  },
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "implementation", type: "address" }],
  },
];
const PROCESSOR_ADDRESS = "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C";
const CREATOR_ADDRESS = "0x6Dfd4ce1950B3Ba351a9d56E73165F7D102C9160";
const BEACON_ADDRESS = "0xf8D6d8EB894d6971c8976Ad8b4971cbEFE028156";
const IMPLEMENTATION_ADDRESS = "0xb9e2F952b67c54f28A8fAe544CE5A15BA31761de";
const FIXED_BLOCK_NUMBER = 117_056_298;
const FIXED_BLOCK_TAG = toHex(FIXED_BLOCK_NUMBER);
const MOCK_PROXY_CODE =
  "0x60806040819052635c60da1b60e01b81526020816004817f000000000000000000000000f8d6d8eb894d6971c8976ad8b4971cbefe0281566001600160a01b03165afa90811560a6575f916053575b5060d5565b905060203d60201160a0575b601f8101601f191682019167ffffffffffffffff831181841017608c576087926040520160b1565b5f604e565b634e487b7160e01b5f52604160045260245ffd5b503d605f565b6040513d5f823e3d90fd5b602090607f19011260d1576080516001600160a01b038116810360d15790565b5f80fd5b5f8091368280378136915af43d5f803e1560ed573d5ff35b3d5ffdfea2646970667358221220c2e8270f3a3f13f5fd821ce105141f9eef95453fdd7c6180fa1237b10fa7235664736f6c63430008180033";
const BEACON_STORAGE_WORD = `0x${"0".repeat(24)}${BEACON_ADDRESS.slice(2).toLowerCase()}`;
const adder8Source = readFileSync(
  new URL("../lib/adder8-tapeout.ts", import.meta.url),
  "utf8",
);
const ADDER8_NETLIST = adder8Source.match(
  /export const ADDER8_NETLIST =\s*\n\s*"(0x[0-9a-f]+)" as Hex;/,
)?.[1];
assert.ok(ADDER8_NETLIST, "expected the pinned 8-bit adder netlist fixture");
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
  const state = {
    beaconWord: BEACON_STORAGE_WORD,
    circuitInfo: [16, 9, 0, 68],
    circuitOwner: CREATOR_ADDRESS,
    circuitNetlist: ADDER8_NETLIST,
    forcedOutput: undefined,
    forcedRpcResult: undefined,
    implementation: IMPLEMENTATION_ADDRESS,
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpcRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(rpcRequest);

    let result;
    if (rpcRequest.method === "eth_chainId") result = "0x38";
    if (rpcRequest.method === "eth_blockNumber") result = FIXED_BLOCK_TAG;
    if (rpcRequest.method === "eth_getCode") result = code;
    if (rpcRequest.method === "eth_getStorageAt") result = state.beaconWord;
    if (rpcRequest.method === "eth_call") {
      const decoded = decodeFunctionData({
        abi: PROCESSOR_ABI,
        data: rpcRequest.params[0].data,
      });
      let output;
      if (decoded.functionName === "eval") {
        const [circuitId, inputBytes] = decoded.args;
        output = state.forcedOutput ?? resolveOutput(Number(circuitId), inputBytes);
      } else if (decoded.functionName === "circuitInfo") {
        output = state.circuitInfo;
      } else if (decoded.functionName === "ownerOf") {
        output = state.circuitOwner;
      } else if (decoded.functionName === "netlist") {
        output = state.circuitNetlist;
      } else if (decoded.functionName === "implementation") {
        output = state.implementation;
      }
      result =
        decoded.functionName === "eval" && state.forcedRpcResult
          ? state.forcedRpcResult
          : encodeFunctionResult({
              abi: PROCESSOR_ABI,
              functionName: decoded.functionName,
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
      assert.equal(status.circuits.length, 6);
      assert.equal(status.circuits.every(({ configured }) => !configured), true);
      assert.equal(status.circuits.every((circuit) => !("address" in circuit)), true);

      const calculationResponse = await postCalculation("adder8", [1, 1]);
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

test("rejects unsupported circuits and invalid inputs before chain access", async (t) => {
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
    {
      name: "8-bit adder requires exactly two operands",
      body: { circuit: "adder8", inputs: [1] },
      code: "INVALID_INPUT",
    },
    {
      name: "8-bit adder rejects negative operands",
      body: { circuit: "adder8", inputs: [-1, 0] },
      code: "INVALID_INPUT",
    },
    {
      name: "8-bit adder rejects operands above 255",
      body: { circuit: "adder8", inputs: [0, 256] },
      code: "INVALID_INPUT",
    },
    {
      name: "8-bit adder rejects fractional operands",
      body: { circuit: "adder8", inputs: [1.5, 2] },
      code: "INVALID_INPUT",
    },
    {
      name: "8-bit adder rejects string operands",
      body: { circuit: "adder8", inputs: ["1", 2] },
      code: "INVALID_INPUT",
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
  };
  const circuits = [
    { key: "nand", id: 1 },
    { key: "not", id: 2 },
    { key: "and", id: 3 },
    { key: "xor", id: 4 },
  ];
  const adderVectors = [
    { a: 0, b: 0, output: "0x0000", result: 0 },
    { a: 1, b: 1, output: "0x0200", result: 2 },
    { a: 1, b: 255, output: "0x0001", result: 256 },
    { a: 123, b: 77, output: "0xc800", result: 200 },
    { a: 255, b: 255, output: "0xfe01", result: 510 },
  ];
  const rpc = await startMockRpc({
    resolveOutput(circuitId, inputBytes) {
      if (circuitId === 6) {
        const vector = adderVectors.find(
          ({ a, b }) =>
            inputBytes.toLowerCase() ===
            `0x${a.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
        );
        assert.ok(vector, "mock received an unsupported 8-bit adder input");
        return vector.output;
      }
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
      assert.deepEqual(
        status.circuits.map(({ key, number }) => [key, number]),
        [
          ["nand", 1],
          ["not", 2],
          ["and", 3],
          ["xor", 4],
          ["halfAdder", 5],
          ["adder8", 6],
        ],
      );
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
          assert.deepEqual(payload.outputs, { result: expectedByte });

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

      for (const vector of adderVectors) {
        const inputs = [vector.a, vector.b];
        const response = await postCalculation("adder8", inputs);
        assert.equal(response.status, 200, `adder8 ${vector.a} + ${vector.b}`);
        const payload = await response.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.circuit, "adder8");
        assert.deepEqual(payload.inputs, inputs);
        assert.deepEqual(payload.outputs, {
          result: vector.result,
          low: vector.result & 0xff,
          carry: (vector.result >> 8) & 1,
          binary: vector.result.toString(2).padStart(9, "0"),
        });

        const packedInput = `0x${vector.a.toString(16).padStart(2, "0")}${vector.b.toString(16).padStart(2, "0")}`;
        assert.equal(
          payload.evidence.calldata,
          encodeFunctionData({
            abi: PROCESSOR_ABI,
            functionName: "eval",
            args: [6n, packedInput],
          }),
        );
        assert.equal(
          payload.evidence.rawResult,
          encodeFunctionResult({
            abi: PROCESSOR_ABI,
            functionName: "eval",
            result: vector.output,
          }),
        );
      }

      const codeRequests = rpc.requests.filter(({ method }) => method === "eth_getCode");
      const storageRequests = rpc.requests.filter(
        ({ method }) => method === "eth_getStorageAt",
      );
      const callRequests = rpc.requests.filter(({ method }) => method === "eth_call");
      assert.equal(codeRequests.length, 20);
      assert.equal(storageRequests.length, 20);
      assert.equal(
        callRequests.filter(
          ({ params }) =>
            decodeFunctionData({ abi: PROCESSOR_ABI, data: params[0].data })
              .functionName === "eval",
        ).length,
        19,
      );
      assert.equal(
        codeRequests.every(({ params }) => params[1] === FIXED_BLOCK_TAG),
        true,
      );
      assert.equal(
        storageRequests.every(({ params }) => params[2] === FIXED_BLOCK_TAG),
        true,
      );
      assert.equal(
        callRequests.every(({ params }) => params[1] === FIXED_BLOCK_TAG),
        true,
      );
      assert.equal(
        callRequests.every(
          ({ params }) =>
            params[0].to === PROCESSOR_ADDRESS || params[0].to === BEACON_ADDRESS,
        ),
        true,
      );
    });
  } finally {
    await rpc.close();
  }
});

test("rejects malformed, non-canonical, and unused-bit processor outputs", async () => {
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
        { circuit: "adder8", inputs: [1, 1], output: "0x00" },
        { circuit: "adder8", inputs: [1, 1], output: "0x000000" },
        { circuit: "adder8", inputs: [1, 1], output: "0x00fe" },
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

      rpc.state.forcedOutput = undefined;
      rpc.state.forcedRpcResult =
        `0x${"0".repeat(62)}40${"0".repeat(64)}${"0".repeat(63)}2` +
        `0200${"0".repeat(60)}`;
      const nonCanonical = await postCalculation("adder8", [1, 1]);
      assert.equal(nonCanonical.status, 502);
      assert.equal(
        (await nonCanonical.json()).error.code,
        "INVALID_CONTRACT_RESPONSE",
      );
    });
  } finally {
    await rpc.close();
  }
});

test("fails closed when the pinned Circuit #6 or beacon implementation changes", async (t) => {
  const cases = [
    {
      name: "circuit metadata mismatch",
      mutate(state) {
        state.circuitInfo = [16, 8, 0, 68];
      },
      code: "CIRCUIT_MISMATCH",
    },
    {
      name: "circuit netlist mismatch",
      mutate(state) {
        state.circuitNetlist = "0x00";
      },
      code: "CIRCUIT_MISMATCH",
    },
    {
      name: "circuit owner mismatch",
      mutate(state) {
        state.circuitOwner = IMPLEMENTATION_ADDRESS;
      },
      code: "CIRCUIT_MISMATCH",
    },
    {
      name: "beacon mismatch",
      mutate(state) {
        state.beaconWord = `0x${"0".repeat(24)}${CREATOR_ADDRESS.slice(2).toLowerCase()}`;
      },
      code: "BEACON_MISMATCH",
    },
    {
      name: "implementation mismatch",
      mutate(state) {
        state.implementation = CREATOR_ADDRESS;
      },
      code: "IMPLEMENTATION_MISMATCH",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const rpc = await startMockRpc({
        resolveOutput() {
          return "0x0000";
        },
      });
      testCase.mutate(rpc.state);

      try {
        await withEnvironment(mockEnvironment(rpc.url), async () => {
          const statusResponse = await fetchApi("/api/status");
          const status = await statusResponse.json();
          assert.equal(status.status, "degraded");
          assert.equal(status.chain.online, false);
          assert.equal(status.error.code, testCase.code);

          const response = await postCalculation("adder8", [1, 1]);
          assert.equal(response.status, 502);
          const payload = await response.json();
          assert.equal(payload.error.code, testCase.code);
          assert.equal("outputs" in payload, false);
          assert.equal("evidence" in payload, false);
          assert.equal(
            rpc.requests
              .filter(({ method }) => method === "eth_call")
              .some(
                ({ params }) =>
                  decodeFunctionData({ abi: PROCESSOR_ABI, data: params[0].data })
                    .functionName === "eval",
              ),
            false,
          );
        });
      } finally {
        await rpc.close();
      }
    });
  }
});

test("rejects changed MINI-4 proxy bytecode before any contract call", async () => {
  const rpc = await startMockRpc({
    code: "0x6000",
    resolveOutput() {
      return "0x0000";
    },
  });

  try {
    await withEnvironment(mockEnvironment(rpc.url), async () => {
      const statusResponse = await fetchApi("/api/status");
      const status = await statusResponse.json();
      assert.equal(status.status, "degraded");
      assert.equal(status.error.code, "PROCESSOR_CODE_MISMATCH");

      const response = await postCalculation("adder8", [1, 1]);
      assert.equal(response.status, 502);
      assert.equal(
        (await response.json()).error.code,
        "PROCESSOR_CODE_MISMATCH",
      );
      assert.equal(rpc.requests.some(({ method }) => method === "eth_call"), false);
    });
  } finally {
    await rpc.close();
  }
});

test("rejects a configured processor address that is not MINI-4", async () => {
  const rpc = await startMockRpc({
    resolveOutput() {
      return "0x0000";
    },
  });

  try {
    await withEnvironment(
      {
        ...mockEnvironment(rpc.url),
        NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS: CREATOR_ADDRESS,
      },
      async () => {
        const statusResponse = await fetchApi("/api/status");
        const status = await statusResponse.json();
        assert.equal(status.status, "degraded");
        assert.equal(status.error.code, "PROCESSOR_MISMATCH");

        const response = await postCalculation("adder8", [1, 1]);
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, "PROCESSOR_MISMATCH");
        assert.equal(rpc.requests.some(({ method }) => method === "eth_getCode"), false);
        assert.equal(rpc.requests.some(({ method }) => method === "eth_call"), false);
      },
    );
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

      const response = await postCalculation("adder8", [1, 1]);
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
