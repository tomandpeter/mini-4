import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  http,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

import {
  CIRCUIT_KEYS,
  getMini4Config,
  type CircuitConfig,
  type CircuitKey,
  type CircuitParameterType,
  type Mini4Config,
  type SupportedChainId,
} from "@/lib/mini4-config";

export type Bit = 0 | 1;

export interface CalculationInput {
  circuit: CircuitKey;
  inputs: readonly Bit[];
}

export interface ScalarOutputs {
  result: Bit;
}

export interface HalfAdderOutputs {
  sum: Bit;
  carry: Bit;
  binary: "00" | "01" | "10";
  decimal: 0 | 1 | 2;
}

export type CircuitOutputs = ScalarOutputs | HalfAdderOutputs;

export interface CalculationEvidence {
  chainId: SupportedChainId;
  blockNumber: string;
  address: Address;
  calldata: Hex;
  rawResult: Hex;
  explorerUrl: string;
  durationMs: number;
}

export interface CalculationSuccess {
  ok: true;
  circuit: CircuitKey;
  inputs: readonly Bit[];
  outputs: CircuitOutputs;
  evidence: CalculationEvidence;
}

export class Mini4Error extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "Mini4Error";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isCircuitKey(value: unknown): value is CircuitKey {
  return typeof value === "string" && (CIRCUIT_KEYS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBit(value: unknown): value is Bit {
  return value === 0 || value === 1;
}

export function parseCalculationInput(value: unknown): CalculationInput {
  if (!isPlainObject(value)) {
    throw new Mini4Error("INVALID_REQUEST", "Request body must be a JSON object.", 400);
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== "circuit" && key !== "inputs")) {
    throw new Mini4Error(
      "INVALID_REQUEST",
      "Request body only accepts circuit and inputs.",
      400,
    );
  }

  if (!isCircuitKey(value.circuit)) {
    throw new Mini4Error(
      "INVALID_CIRCUIT",
      "circuit must be nand, not, and, xor, or halfAdder.",
      400,
    );
  }

  if (!Array.isArray(value.inputs)) {
    throw new Mini4Error("INVALID_INPUT", "inputs must be an array of 0/1 bits.", 400);
  }

  const expectedCount = value.circuit === "not" ? 1 : 2;
  if (value.inputs.length !== expectedCount || !value.inputs.every(isBit)) {
    throw new Mini4Error(
      "INVALID_INPUT",
      `${value.circuit} requires exactly ${expectedCount} numeric 0/1 bit${expectedCount === 1 ? "" : "s"}.`,
      400,
    );
  }

  return {
    circuit: value.circuit,
    inputs: value.inputs as Bit[],
  };
}

function encodeBit(parameterType: CircuitParameterType, bit: Bit): Hex {
  if (parameterType === "bool") {
    return encodeAbiParameters([{ type: "bool" }], [bit === 1]);
  }

  return encodeAbiParameters([{ type: "uint8" }], [bit]);
}

function encodeCalldata(circuit: CircuitConfig, inputs: readonly Bit[]): Hex {
  if (!circuit.parsedSignature) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      `${circuit.label} function signature is not configured correctly.`,
      503,
    );
  }

  const selector = toFunctionSelector(circuit.parsedSignature.canonical);
  const words = circuit.parsedSignature.parameterTypes.map((parameterType, index) =>
    encodeBit(parameterType, inputs[index]),
  );
  return concatHex([selector, ...words]);
}

function decodeBitWord(word: string): Bit {
  const value = BigInt(`0x${word}`);
  if (value !== BigInt(0) && value !== BigInt(1)) {
    throw new Mini4Error(
      "INVALID_CONTRACT_RESPONSE",
      "The contract returned a value other than 0 or 1.",
      502,
    );
  }
  return Number(value) as Bit;
}

function decodeOutputs(circuit: CircuitKey, rawResult: unknown): { rawResult: Hex; outputs: CircuitOutputs } {
  const wordCount = circuit === "halfAdder" ? 2 : 1;
  const expectedHexLength = 2 + wordCount * 64;

  if (
    typeof rawResult !== "string" ||
    rawResult.length !== expectedHexLength ||
    !/^0x[0-9a-fA-F]+$/.test(rawResult)
  ) {
    throw new Mini4Error(
      "INVALID_CONTRACT_RESPONSE",
      `The contract must return exactly ${wordCount} ABI word${wordCount === 1 ? "" : "s"}.`,
      502,
    );
  }

  const words = Array.from({ length: wordCount }, (_, index) =>
    rawResult.slice(2 + index * 64, 2 + (index + 1) * 64),
  );

  if (circuit !== "halfAdder") {
    return {
      rawResult: rawResult as Hex,
      outputs: { result: decodeBitWord(words[0]) },
    };
  }

  const sum = decodeBitWord(words[0]);
  const carry = decodeBitWord(words[1]);
  if (sum === 1 && carry === 1) {
    throw new Mini4Error(
      "INVALID_CONTRACT_RESPONSE",
      "The half adder returned an impossible SUM/CARRY combination.",
      502,
    );
  }
  const decimal = (carry * 2 + sum) as 0 | 1 | 2;

  return {
    rawResult: rawResult as Hex,
    outputs: {
      sum,
      carry,
      binary: `${carry}${sum}` as HalfAdderOutputs["binary"],
      decimal,
    },
  };
}

function requireChainConfiguration(config: Mini4Config): {
  chainId: SupportedChainId;
  rpcUrl: string;
} {
  if (!config.chain.supported || config.chain.id === null) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      "NEXT_PUBLIC_MINI4_CHAIN_ID must be 56 or 97.",
      503,
    );
  }
  if (!config.chain.rpcUrl) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      "NEXT_PUBLIC_MINI4_RPC_URL is required for on-chain calculation.",
      503,
    );
  }

  return { chainId: config.chain.id, rpcUrl: config.chain.rpcUrl };
}

function makeClient(rpcUrl: string) {
  return createPublicClient({
    transport: http(rpcUrl, {
      retryCount: 1,
      timeout: 8_000,
    }),
  });
}

async function readChainHead(chainId: SupportedChainId, rpcUrl: string) {
  const client = makeClient(rpcUrl);
  let actualChainId: number;
  let blockNumber: bigint;

  try {
    [actualChainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
  } catch {
    throw new Mini4Error(
      "RPC_UNAVAILABLE",
      "The configured BNB RPC endpoint is unavailable.",
      502,
    );
  }

  if (actualChainId !== chainId) {
    throw new Mini4Error(
      "CHAIN_MISMATCH",
      `The RPC endpoint reports chain ${actualChainId}, expected ${chainId}.`,
      502,
    );
  }

  return { client, blockNumber };
}

export async function probeMini4Chain(): Promise<{
  chainId: SupportedChainId;
  blockNumber: string;
}> {
  const config = getMini4Config();
  const { chainId, rpcUrl } = requireChainConfiguration(config);
  const { blockNumber } = await readChainHead(chainId, rpcUrl);
  return { chainId, blockNumber: blockNumber.toString() };
}

export async function calculateOnChain(input: CalculationInput): Promise<CalculationSuccess> {
  const startedAt = Date.now();
  const config = getMini4Config();
  const circuit = config.circuits[input.circuit];

  if (!circuit.address || !circuit.configured) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      `Circuit #${circuit.number} ${circuit.label} is not configured; local calculation is disabled.`,
      503,
    );
  }

  const { chainId, rpcUrl } = requireChainConfiguration(config);
  const calldata = encodeCalldata(circuit, input.inputs);
  const { client, blockNumber } = await readChainHead(chainId, rpcUrl);
  const blockTag = `0x${blockNumber.toString(16)}` as Hex;
  let rpcResult: unknown;

  try {
    rpcResult = await client.request({
      method: "eth_call",
      params: [
        {
          to: circuit.address,
          data: calldata,
        },
        blockTag,
      ],
    });
  } catch {
    throw new Mini4Error(
      "RPC_CALL_FAILED",
      "The BNB eth_call failed; no local result was generated.",
      502,
    );
  }

  const decoded = decodeOutputs(input.circuit, rpcResult);

  return {
    ok: true,
    circuit: input.circuit,
    inputs: input.inputs,
    outputs: decoded.outputs,
    evidence: {
      chainId,
      blockNumber: blockNumber.toString(),
      address: circuit.address,
      calldata,
      rawResult: decoded.rawResult,
      explorerUrl: `${config.chain.explorerBaseUrl}/address/${circuit.address}`,
      durationMs: Date.now() - startedAt,
    },
  };
}
