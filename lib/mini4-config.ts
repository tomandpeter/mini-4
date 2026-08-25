import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const CIRCUIT_KEYS = [
  "nand",
  "not",
  "and",
  "xor",
  "adder8",
] as const;

export type CircuitKey = (typeof CIRCUIT_KEYS)[number];
export type CircuitStatusKey = CircuitKey | "halfAdder";
export type SupportedChainId = 56;

const DEFAULT_CHAIN_ID = "56";
const DEFAULT_RPC_URL = "https://bsc-dataseed.binance.org";
const DEFAULT_EXPLORER_URL = "https://bscscan.com";
const DEFAULT_PROCESSOR_ADDRESS = "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C";

interface CircuitDefinition {
  key: CircuitStatusKey;
  number: 1 | 2 | 3 | 4 | 5 | 6;
  label: string;
  inputCount: 1 | 2 | 16;
}

export interface CircuitConfig extends CircuitDefinition {
  address?: Address;
  configured: boolean;
  error?: string;
}

export interface Mini4Config {
  chain: {
    id: SupportedChainId | null;
    name: string;
    supported: boolean;
    rpcUrl?: string;
    rpcConfigured: boolean;
    explorerBaseUrl: string;
  };
  processor: {
    address?: Address;
    configured: boolean;
    error?: string;
  };
  circuits: Record<CircuitStatusKey, CircuitConfig>;
  blockers: readonly string[];
}

const circuitDefinitions: readonly CircuitDefinition[] = [
  { key: "nand", number: 1, label: "NAND", inputCount: 2 },
  { key: "not", number: 2, label: "NOT", inputCount: 1 },
  { key: "and", number: 3, label: "AND", inputCount: 2 },
  { key: "xor", number: 4, label: "XOR", inputCount: 2 },
  { key: "halfAdder", number: 5, label: "Half Adder", inputCount: 2 },
  { key: "adder8", number: 6, label: "8-bit Adder", inputCount: 16 },
];

function readRawEnvironment() {
  return {
    chainId: process.env.NEXT_PUBLIC_MINI4_CHAIN_ID ?? DEFAULT_CHAIN_ID,
    rpcUrl: process.env.NEXT_PUBLIC_MINI4_RPC_URL ?? DEFAULT_RPC_URL,
    explorerUrl: process.env.NEXT_PUBLIC_MINI4_EXPLORER_URL ?? DEFAULT_EXPLORER_URL,
    processorAddress:
      process.env.NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS ?? DEFAULT_PROCESSOR_ADDRESS,
  };
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseHttpUrl(value: string | undefined): string | undefined {
  const candidate = optionalValue(value);
  if (!candidate) return undefined;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseAddress(value: string | undefined): Address | undefined {
  const candidate = optionalValue(value);
  if (!candidate || !isAddress(candidate)) return undefined;

  const address = getAddress(candidate);
  return address === zeroAddress ? undefined : address;
}

function parseChainId(value: string): SupportedChainId | null {
  return value.trim() === "56" ? 56 : null;
}

export function getMini4Config(): Mini4Config {
  const rawEnvironment = readRawEnvironment();
  const chainId = parseChainId(rawEnvironment.chainId);
  const rpcCandidate = optionalValue(rawEnvironment.rpcUrl);
  const rpcUrl = parseHttpUrl(rawEnvironment.rpcUrl);
  const explorerCandidate = optionalValue(rawEnvironment.explorerUrl);
  const explorerUrl = parseHttpUrl(rawEnvironment.explorerUrl);
  const processorCandidate = optionalValue(rawEnvironment.processorAddress);
  const processorAddress = parseAddress(rawEnvironment.processorAddress);
  const processorError = !processorCandidate
    ? "processor address is not configured"
    : !processorAddress
      ? "processor address is invalid"
      : undefined;
  const processorConfigured = Boolean(processorAddress);

  const circuitEntries = circuitDefinitions.map((definition) => [
    definition.key,
    {
      ...definition,
      address: processorAddress,
      configured: processorConfigured,
      ...(processorError ? { error: processorError } : {}),
    },
  ] as const);
  const circuits = Object.fromEntries(circuitEntries) as Record<
    CircuitStatusKey,
    CircuitConfig
  >;
  const blockers: string[] = [];

  if (chainId === null) {
    blockers.push("NEXT_PUBLIC_MINI4_CHAIN_ID must be 56");
  }
  if (!rpcCandidate) {
    blockers.push("NEXT_PUBLIC_MINI4_RPC_URL is not configured");
  } else if (!rpcUrl) {
    blockers.push("NEXT_PUBLIC_MINI4_RPC_URL must be an HTTP(S) URL");
  }
  if (!explorerCandidate) {
    blockers.push("NEXT_PUBLIC_MINI4_EXPLORER_URL is not configured");
  } else if (!explorerUrl) {
    blockers.push("NEXT_PUBLIC_MINI4_EXPLORER_URL must be an HTTP(S) URL");
  }
  if (processorError) {
    blockers.push(`NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS: ${processorError}`);
  }

  return {
    chain: {
      id: chainId,
      name: chainId === 56 ? "BNB Smart Chain" : "Unsupported BNB chain",
      supported: chainId === 56,
      rpcUrl,
      rpcConfigured: Boolean(rpcUrl),
      explorerBaseUrl: (explorerUrl ?? DEFAULT_EXPLORER_URL).replace(/\/+$/, ""),
    },
    processor: {
      address: processorAddress,
      configured: processorConfigured,
      ...(processorError ? { error: processorError } : {}),
    },
    circuits,
    blockers,
  };
}
