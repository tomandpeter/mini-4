import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";

import {
  CIRCUIT_KEYS,
  getMini4Config,
  type CircuitConfig,
  type CircuitKey,
  type Mini4Config,
  type SupportedChainId,
} from "@/lib/mini4-config";

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
] as const;

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

function packInputBits(inputs: readonly Bit[]): Hex {
  const packed = inputs[0] | ((inputs[1] ?? 0) << 1);
  return toHex(packed, { size: 1 });
}

function encodeProcessorCalldata(circuit: CircuitConfig, inputs: readonly Bit[]): Hex {
  return encodeFunctionData({
    abi: PROCESSOR_ABI,
    functionName: "eval",
    args: [BigInt(circuit.number), packInputBits(inputs)],
  });
}

function invalidContractResponse(message: string): Mini4Error {
  return new Mini4Error("INVALID_CONTRACT_RESPONSE", message, 502);
}

function decodeProcessorOutput(
  circuit: CircuitKey,
  rawResult: unknown,
): { rawResult: Hex; outputs: CircuitOutputs } {
  if (
    typeof rawResult !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(rawResult)
  ) {
    throw invalidContractResponse("The processor returned malformed ABI data.");
  }

  const encodedResult = rawResult as Hex;
  let outputBytes: Hex;
  try {
    outputBytes = decodeFunctionResult({
      abi: PROCESSOR_ABI,
      functionName: "eval",
      data: encodedResult,
    });
  } catch {
    throw invalidContractResponse("The processor returned invalid bytes ABI data.");
  }

  if (!/^0x[0-9a-fA-F]{2}$/.test(outputBytes)) {
    throw invalidContractResponse("The processor output must contain exactly one byte.");
  }

  const canonicalResult = encodeFunctionResult({
    abi: PROCESSOR_ABI,
    functionName: "eval",
    result: outputBytes,
  });
  if (canonicalResult.toLowerCase() !== encodedResult.toLowerCase()) {
    throw invalidContractResponse("The processor returned non-canonical bytes ABI data.");
  }

  const outputByte = Number.parseInt(outputBytes.slice(2), 16);
  if (circuit !== "halfAdder") {
    if ((outputByte & 0xfe) !== 0) {
      throw invalidContractResponse("The processor set unused scalar output bits.");
    }
    return {
      rawResult: encodedResult,
      outputs: { result: outputByte as Bit },
    };
  }

  if ((outputByte & 0xfc) !== 0 || outputByte === 3) {
    throw invalidContractResponse("The processor returned an invalid half-adder output byte.");
  }

  const sum = (outputByte & 1) as Bit;
  const carry = ((outputByte >> 1) & 1) as Bit;
  return {
    rawResult: encodedResult,
    outputs: {
      sum,
      carry,
      binary: `${carry}${sum}` as HalfAdderOutputs["binary"],
      decimal: outputByte as HalfAdderOutputs["decimal"],
    },
  };
}

function requireChainConfiguration(config: Mini4Config): {
  chainId: SupportedChainId;
  rpcUrl: string;
  processorAddress: Address;
} {
  if (!config.chain.supported || config.chain.id !== 56) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      "NEXT_PUBLIC_MINI4_CHAIN_ID must be 56.",
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
  if (!config.processor.address || !config.processor.configured) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      "NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS is required; local calculation is disabled.",
      503,
    );
  }
  if (config.blockers.length > 0) {
    throw new Mini4Error(
      "CONFIGURATION_BLOCKED",
      "The public MINI-4 chain configuration is invalid; local calculation is disabled.",
      503,
    );
  }

  return {
    chainId: config.chain.id,
    rpcUrl: config.chain.rpcUrl,
    processorAddress: config.processor.address,
  };
}

function makeClient(rpcUrl: string) {
  return createPublicClient({
    transport: http(rpcUrl, {
      retryCount: 1,
      timeout: 8_000,
    }),
  });
}

async function readProcessorAtChainHead(
  chainId: SupportedChainId,
  rpcUrl: string,
  processorAddress: Address,
) {
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

  let bytecode: Hex | undefined;
  try {
    bytecode = await client.getCode({
      address: processorAddress,
      blockNumber,
    });
  } catch {
    throw new Mini4Error(
      "RPC_UNAVAILABLE",
      "The processor bytecode could not be read from the configured BNB RPC endpoint.",
      502,
    );
  }

  if (!bytecode || bytecode === "0x") {
    throw new Mini4Error(
      "PROCESSOR_CODE_MISSING",
      "The configured processor address has no bytecode at the fixed block.",
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
  const { chainId, rpcUrl, processorAddress } = requireChainConfiguration(config);
  const { blockNumber } = await readProcessorAtChainHead(
    chainId,
    rpcUrl,
    processorAddress,
  );
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

  const { chainId, rpcUrl, processorAddress } = requireChainConfiguration(config);
  const calldata = encodeProcessorCalldata(circuit, input.inputs);
  const { client, blockNumber } = await readProcessorAtChainHead(
    chainId,
    rpcUrl,
    processorAddress,
  );
  const blockTag = `0x${blockNumber.toString(16)}` as Hex;
  let rpcResult: unknown;

  try {
    rpcResult = await client.request({
      method: "eth_call",
      params: [
        {
          to: processorAddress,
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

  const decoded = decodeProcessorOutput(input.circuit, rpcResult);

  return {
    ok: true,
    circuit: input.circuit,
    inputs: input.inputs,
    outputs: decoded.outputs,
    evidence: {
      chainId,
      blockNumber: blockNumber.toString(),
      address: processorAddress,
      calldata,
      rawResult: decoded.rawResult,
      explorerUrl: `${config.chain.explorerBaseUrl}/address/${processorAddress}`,
      durationMs: Date.now() - startedAt,
    },
  };
}
