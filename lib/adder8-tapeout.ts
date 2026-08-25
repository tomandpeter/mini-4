import { getAddress, type Address, type Hex } from "viem";

export const MINI4_CHAIN_ID = 56 as const;
export const MINI4_PROCESSOR = getAddress(
  "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C",
);
export const MINI4_TRANSISTORS = getAddress(
  "0xA7Ab60450b9C94620C5385def389e901580E47c2",
);
export const MINI4_CREATOR = getAddress(
  "0x6Dfd4ce1950B3Ba351a9d56E73165F7D102C9160",
);

export const MINI4_BEACON = getAddress(
  "0xf8d6d8eb894d6971c8976ad8b4971cbefe028156",
);
export const MINI4_IMPLEMENTATION = getAddress(
  "0xb9e2F952b67c54f28A8fAe544CE5A15BA31761de",
);
export const MINI4_PROXY_CODE_HASH =
  "0xd8c4b0216e0aadd615fbd134465b6af060a11769edc7c844d8f14d1b8a783992" as Hex;
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;

export const ADDER8_TASK_ID = 38 as const;
export const ADDER8_SOURCE_TASK_ID = 39 as const;
export const ADDER8_CIRCUIT_ID = 6n;
export const ADDER8_EXPECTED_PREVIOUS_ID = 5n;
export const ADDER8_INPUTS = 16;
export const ADDER8_OUTPUTS = 9;
export const ADDER8_NAND_COUNT = 68n;
export const ADDER8_NETLIST_BYTES = 476;
export const ADDER8_NETLIST_SHA256 =
  "0xfcabd68bd2aecc2b53b3f660ca7aab8defa8d67c929e1c79ca763c9008ff4933" as Hex;
export const ADDER8_NETLIST_KECCAK256 =
  "0x288a84a20d5e02e007179e97f7137375b5c8ebb7465f618ab84f054fe5570e60" as Hex;

// TapeOut's pinned REF-free reference implementation for task 38/src 39.
// Encoding: one 7-byte NAND cell = opcode:uint8 + left:uint24be + right:uint24be.
export const ADDER8_NETLIST =
  "0x0000000200000a000000020000120000000a000012000000120000120000000300000b000000030000160000000b00001600000017000018000000190000150000001900001a0000001500001a0000001600001a0000000400000c0000000400001e0000000c00001e0000001f0000200000002100001d000000210000220000001d0000220000001e0000220000000500000d000000050000260000000d00002600000027000028000000290000250000002900002a0000002500002a0000002600002a0000000600000e0000000600002e0000000e00002e0000002f0000300000003100002d000000310000320000002d0000320000002e0000320000000700000f000000070000360000000f00003600000037000038000000390000350000003900003a0000003500003a0000003600003a000000080000100000000800003e0000001000003e0000003f0000400000004100003d000000410000420000003d0000420000003e00004200000009000011000000090000460000001100004600000047000048000000490000450000004900004a0000004500004a000000130000140000001b00001c000000230000240000002b00002c000000330000340000003b00003c000000430000440000004b00004c0000004600004a" as Hex;

export const PROCESSOR_TAPEOUT_ABI = [
  {
    type: "function",
    name: "transistors",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "nextId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tapeout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nl", type: "bytes" },
      { name: "nIn", type: "uint32" },
      { name: "nOut", type: "uint32" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "netlist",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "eval",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "inputs", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "event",
    name: "TapedOut",
    anonymous: false,
    inputs: [
      { name: "circuitId", type: "uint256", indexed: true },
      { name: "author", type: "address", indexed: true },
      { name: "gateCount", type: "uint32", indexed: false },
      { name: "nState", type: "uint32", indexed: false },
    ],
  },
] as const;

export const TRANSISTOR_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const BEACON_ABI = [
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export function addressFromStorageWord(word: Hex | undefined): Address | undefined {
  if (!word || !/^0x[0-9a-fA-F]{64}$/.test(word)) return undefined;
  return getAddress(`0x${word.slice(-40)}`);
}

export function packAdder8Inputs(a: number, b: number): Hex {
  if (!Number.isInteger(a) || a < 0 || a > 255) {
    throw new RangeError("A must be an integer from 0 to 255.");
  }
  if (!Number.isInteger(b) || b < 0 || b > 255) {
    throw new RangeError("B must be an integer from 0 to 255.");
  }
  return `0x${a.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}` as Hex;
}

export function decodeAdder8Output(output: Hex): number {
  if (!/^0x[0-9a-fA-F]{4}$/.test(output)) {
    throw new Error("8-bit adder output must contain exactly two bytes.");
  }
  const low = Number.parseInt(output.slice(2, 4), 16);
  const high = Number.parseInt(output.slice(4, 6), 16);
  if ((high & 0xfe) !== 0) {
    throw new Error("8-bit adder set unused output bits.");
  }
  return low | (high << 8);
}
