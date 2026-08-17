import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const CIRCUIT_KEYS = [
  "nand",
  "not",
  "and",
  "xor",
  "halfAdder",
] as const;

export type CircuitKey = (typeof CIRCUIT_KEYS)[number];
export type SupportedChainId = 56 | 97;
export type CircuitParameterType = "bool" | "uint8";

export interface ParsedFunctionSignature {
  canonical: string;
  name: string;
  parameterTypes: readonly CircuitParameterType[];
}

interface CircuitDefinition {
  key: CircuitKey;
  number: number;
  label: string;
  inputCount: 1 | 2;
  defaultSignature: string;
  addressValue: string | undefined;
  signatureValue: string | undefined;
}

export interface CircuitConfig {
  key: CircuitKey;
  number: number;
  label: string;
  inputCount: 1 | 2;
  address?: Address;
  signature: string;
  parsedSignature?: ParsedFunctionSignature;
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
  circuits: Record<CircuitKey, CircuitConfig>;
  blockers: readonly string[];
}

function readRawEnvironment() {
  return {
    chainId: process.env.NEXT_PUBLIC_MINI4_CHAIN_ID,
    rpcUrl: process.env.NEXT_PUBLIC_MINI4_RPC_URL,
    explorerUrl: process.env.NEXT_PUBLIC_MINI4_EXPLORER_URL,
    nandAddress: process.env.NEXT_PUBLIC_MINI4_NAND_ADDRESS,
    nandSignature: process.env.NEXT_PUBLIC_MINI4_NAND_SIGNATURE,
    notAddress: process.env.NEXT_PUBLIC_MINI4_NOT_ADDRESS,
    notSignature: process.env.NEXT_PUBLIC_MINI4_NOT_SIGNATURE,
    andAddress: process.env.NEXT_PUBLIC_MINI4_AND_ADDRESS,
    andSignature: process.env.NEXT_PUBLIC_MINI4_AND_SIGNATURE,
    xorAddress: process.env.NEXT_PUBLIC_MINI4_XOR_ADDRESS,
    xorSignature: process.env.NEXT_PUBLIC_MINI4_XOR_SIGNATURE,
    halfAdderAddress: process.env.NEXT_PUBLIC_MINI4_HALF_ADDER_ADDRESS,
    halfAdderSignature: process.env.NEXT_PUBLIC_MINI4_HALF_ADDER_SIGNATURE,
  };
}

function getCircuitDefinitions(
  rawEnvironment: ReturnType<typeof readRawEnvironment>,
): readonly CircuitDefinition[] {
  return [
    {
      key: "nand",
      number: 1,
      label: "NAND",
      inputCount: 2,
      defaultSignature: "nand(bool,bool)",
      addressValue: rawEnvironment.nandAddress,
      signatureValue: rawEnvironment.nandSignature,
    },
    {
      key: "not",
      number: 2,
      label: "NOT",
      inputCount: 1,
      defaultSignature: "not(bool)",
      addressValue: rawEnvironment.notAddress,
      signatureValue: rawEnvironment.notSignature,
    },
    {
      key: "and",
      number: 3,
      label: "AND",
      inputCount: 2,
      defaultSignature: "and(bool,bool)",
      addressValue: rawEnvironment.andAddress,
      signatureValue: rawEnvironment.andSignature,
    },
    {
      key: "xor",
      number: 4,
      label: "XOR",
      inputCount: 2,
      defaultSignature: "xor(bool,bool)",
      addressValue: rawEnvironment.xorAddress,
      signatureValue: rawEnvironment.xorSignature,
    },
    {
      key: "halfAdder",
      number: 5,
      label: "Half Adder",
      inputCount: 2,
      defaultSignature: "halfAdder(bool,bool)",
      addressValue: rawEnvironment.halfAdderAddress,
      signatureValue: rawEnvironment.halfAdderSignature,
    },
  ];
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

export function parseFunctionSignature(
  value: string,
  inputCount: 1 | 2,
): ParsedFunctionSignature | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/.exec(value.trim());
  if (!match) return undefined;

  const rawParameters = match[2].trim();
  const parameterTypes = rawParameters
    ? rawParameters.split(",").map((parameter) => parameter.trim())
    : [];

  if (
    parameterTypes.length !== inputCount ||
    parameterTypes.some((parameter) => parameter !== "bool" && parameter !== "uint8")
  ) {
    return undefined;
  }

  const typedParameters = parameterTypes as CircuitParameterType[];
  return {
    canonical: `${match[1]}(${typedParameters.join(",")})`,
    name: match[1],
    parameterTypes: typedParameters,
  };
}

function createCircuitConfig(definition: CircuitDefinition): CircuitConfig {
  const rawAddress = optionalValue(definition.addressValue);
  const address = parseAddress(rawAddress);
  const signature = optionalValue(definition.signatureValue) ?? definition.defaultSignature;
  const parsedSignature = parseFunctionSignature(signature, definition.inputCount);
  const errors: string[] = [];

  if (!rawAddress) {
    errors.push("contract address is not configured");
  } else if (!address) {
    errors.push("contract address is invalid");
  }

  if (!parsedSignature) {
    errors.push("function signature must use bool/uint8 parameters with the expected arity");
  }

  return {
    key: definition.key,
    number: definition.number,
    label: definition.label,
    inputCount: definition.inputCount,
    address,
    signature,
    parsedSignature,
    configured: Boolean(address && parsedSignature),
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

function parseChainId(value: string | undefined): SupportedChainId | null {
  const candidate = optionalValue(value) ?? "56";
  if (candidate === "56") return 56;
  if (candidate === "97") return 97;
  return null;
}

export function getMini4Config(): Mini4Config {
  const rawEnvironment = readRawEnvironment();
  const chainId = parseChainId(rawEnvironment.chainId);
  const rpcCandidate = optionalValue(rawEnvironment.rpcUrl);
  const rpcUrl = parseHttpUrl(rpcCandidate);
  const explorerCandidate = optionalValue(rawEnvironment.explorerUrl);
  const explorerUrl = parseHttpUrl(explorerCandidate);
  const defaultExplorerUrl = chainId === 97 ? "https://testnet.bscscan.com/" : "https://bscscan.com/";

  const circuitEntries = getCircuitDefinitions(rawEnvironment).map((definition) => {
    const circuit = createCircuitConfig(definition);
    return [definition.key, circuit] as const;
  });
  const circuits = Object.fromEntries(circuitEntries) as Record<CircuitKey, CircuitConfig>;
  const blockers: string[] = [];

  if (chainId === null) {
    blockers.push("NEXT_PUBLIC_MINI4_CHAIN_ID must be 56 or 97");
  }
  if (!rpcCandidate) {
    blockers.push("NEXT_PUBLIC_MINI4_RPC_URL is not configured");
  } else if (!rpcUrl) {
    blockers.push("NEXT_PUBLIC_MINI4_RPC_URL must be an HTTP(S) URL");
  }
  if (explorerCandidate && !explorerUrl) {
    blockers.push("NEXT_PUBLIC_MINI4_EXPLORER_URL must be an HTTP(S) URL");
  }

  for (const circuit of Object.values(circuits)) {
    if (!circuit.configured) {
      blockers.push(`Circuit #${circuit.number} ${circuit.label}: ${circuit.error}`);
    }
  }

  return {
    chain: {
      id: chainId,
      name:
        chainId === 97
          ? "BNB Smart Chain Testnet"
          : chainId === 56
            ? "BNB Smart Chain"
            : "Unsupported BNB chain",
      supported: chainId !== null,
      rpcUrl,
      rpcConfigured: Boolean(rpcUrl),
      explorerBaseUrl: (explorerUrl ?? defaultExplorerUrl).replace(/\/$/, ""),
    },
    circuits,
    blockers,
  };
}
