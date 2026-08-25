# MINI-4

**A Calculator Built On-Chain — now adding 0–255.**

MINI-4 is a small, honest interface for experimenting with a deployed logic
processor on BNB Smart Chain mainnet. The current version exposes NAND, NOT,
AND, XOR, and an 8-bit adder through one processor contract.

The repository also contains a lightweight [PoD Shadow Miner](miner/README.md)
for an always-on VPS. It watches public TapeOut tasks and protocol publication
signals, verifies MINI-4's public chain presence, reproduces the published
scoring formula, and performs bounded flat-NAND research. It is intentionally
read-only: no wallet, signer, transaction, tape-out, claim, or earnings claim is
present while the reward contract and official task vectors remain unpublished.

The browser calls MINI-4's same-origin API, which sends a read-only `eth_call`
to a BNB Chain RPC endpoint. A node evaluates deployed contract bytecode against
current chain state and returns the result. No wallet, signer, transaction, or
gas payment is required: `eth_call` is not mined and does not change chain
state.

MINI-4 does **not** substitute browser-side arithmetic when a chain call fails.
If the RPC, processor configuration, chain ID, or returned data is invalid, the
calculator fails closed instead of presenting a fabricated result.

## Verified BNB mainnet processor

MINI-4 uses one processor for all six permanent circuit IDs. The public lab
actively calls logic Circuits `#1`–`#4` and the 8-bit adder at Circuit `#6`:

| Property | Value |
| --- | --- |
| Network | BNB Smart Chain mainnet |
| Chain ID | `56` |
| Processor | [`0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C`](https://bscscan.com/address/0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C) |
| Read ABI | `eval(uint256,bytes) returns(bytes)` |

Transaction [`0x969e…134df`](https://bscscan.com/tx/0x969e2f513d19b815f60f3c6f711eb3ff1fbe7f83a6f00e955397973beb1134df)
created Circuit `#6` at BNB block `118027330`. Its fixed metadata is 16 input
bits, 9 output bits, 0 state bits, and 68 NAND gates. The stored 476-byte
netlist has Keccak-256
`0x288a84a20d5e02e007179e97f7137375b5c8ebb7465f618ab84f054fe5570e60`.

The processor address contains beacon-proxy bytecode rather than an immutable
implementation. At the Circuit `#6` verification block, its beacon
`0xf8d6d8eb894d6971c8976ad8b4971cbefe028156` resolved to implementation
`0xb9e2f952b67c54f28a8fae544ce5a15ba31761de`. The website pins the proxy
bytecode, beacon, implementation, Circuit `#6` metadata, owner, and netlist hash
at the same block used for every calculation. Any mismatch pauses calculation
for review; this is verified behavior, not a claim that the beacon can never be
upgraded.

This processor/CPU is **community-created**. It is not an official “Genesis
CPU,” and this repository does not represent it as one. This project also makes
no unverified claims about mint status, supply, sale price, token price, or
investment value.

## Circuit IDs

| ID | Circuit | Input bits | Output bits |
| ---: | --- | --- | --- |
| `1` | NAND | A, B | bit 0 = result |
| `2` | NOT | A | bit 0 = result |
| `3` | AND | A, B | bit 0 = result |
| `4` | XOR | A, B | bit 0 = result |
| `5` | Half adder | A, B | bit 0 = `SUM`, bit 1 = `CARRY` |
| `6` | 8-bit adder | A bits 0–7, B bits 0–7 | low result byte, then carry bit |

Inputs and outputs use little-endian bit packing: bit 0 is the least-significant
bit. For two-input circuits, pack `A` into bit 0 and `B` into bit 1:

```text
packed input = A | (B << 1)
```

The returned `bytes` use the same ordering. Circuits 1–4 return their result in
bit 0. Circuit 5 returns `SUM` in bit 0 and `CARRY` in bit 1. Circuit 6 takes
two bytes as `0xAABB`: the first byte contains A bits 0–7 and the second contains
B bits 0–7. Its output is `0xLLCC`, where `LL` is the low eight result bits and
bit 0 of `CC` is the carry bit.

For `A = 123` and `B = 77`:

```text
input          = 0x7b4d
output         = 0xc800
low byte       = 0xc8 = 200
carry byte     = 0x00
decimal result = 200
```

## Current arithmetic limit

The active arithmetic operation is Circuit ID `6`, an 8-bit adder without a
carry-in. A and B must each be integers from `0` to `255`; the verified result
range is `0` to `510`. The earlier 1-bit half adder remains permanently stored
as Circuit `#5`, but the public calculator now routes addition to Circuit `#6`.

MINI-4 still cannot subtract, multiply, or divide. Circuit IDs `1`–`4` are
individual logic gates, not additional general-purpose arithmetic operations.

## MINI-4 vs ordinary calculator

| | Ordinary calculator | MINI-4 |
| --- | --- | --- |
| Where the calculation runs | Locally, on the device's CPU | On an RPC node executing the processor contract code against BNB Chain state |
| Execution type | Local software operation | Read-only `eth_call` |
| Transaction or consensus | None | The call is not mined, submitted as a transaction, or executed by consensus |
| Wallet and gas | Not required | Not required |
| Speed and range | Fast, flexible, and useful for everyday arithmetic | Slower because of RPC latency; addition is currently limited to two 8-bit operands |
| Evidence | Usually just the displayed result | Can record processor address, block number, calldata, and raw return bytes |
| Purpose | Practical calculation | Education, inspection, and reproducible verification of deployed logic |

The contract code and state referenced by MINI-4 come from the selected chain
block, but the `eth_call` itself is only executed by the responding RPC node. It
does not become a transaction or a consensus record. Recording the processor,
block, calldata, and raw result makes the read inspectable and reproducible; it
does not make MINI-4 faster or more capable than a local calculator.

MINI-4 is therefore an educational and verification-oriented experiment, not a
practical replacement for an ordinary calculator. The processor is also an
upgradeable beacon proxy, so the recorded block remains important: a future
implementation may behave differently after an authorized upgrade.

## Reproduce the chain call

### Foundry `cast`

This is a provider-only read; no private key or wallet flag is needed.

```bash
cast call \
  0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C \
  "eval(uint256,bytes)(bytes)" \
  6 \
  0x7b4d \
  --rpc-url https://bsc-dataseed.binance.org
```

Expected decoded return:

```text
0xc800
```

### ethers v6

Run this in an environment with `ethers@6` installed:

```js
import {
  Contract,
  JsonRpcProvider,
  getBytes,
  hexlify,
} from "ethers";

const provider = new JsonRpcProvider(
  "https://bsc-dataseed.binance.org",
  56,
);

const processor = new Contract(
  "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C",
  ["function eval(uint256 circuitId, bytes input) view returns (bytes)"],
  provider,
);

const circuitId = 6n;
const A = 123;
const B = 77;
const input = hexlify(Uint8Array.of(A, B)); // 0x7b4d

const rawOutput = await processor.eval(circuitId, input);
const [low = 0, carryByte = 0] = getBytes(rawOutput);
const result = low | ((carryByte & 1) << 8);

console.log({ rawOutput, result });
// { rawOutput: "0xc800", result: 200 }
```

The `Contract` has a provider but no signer, so this code can only perform the
read-only call shown above.

## Configuration

The checked-in defaults point to the verified BNB mainnet processor and can be
overridden at build/deployment time:

| Variable | Public default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MINI4_CHAIN_ID` | `56` | Expected network chain ID |
| `NEXT_PUBLIC_MINI4_RPC_URL` | `https://bsc-dataseed.binance.org` | RPC endpoint used for `eth_call` |
| `NEXT_PUBLIC_MINI4_EXPLORER_URL` | `https://bscscan.com` | Explorer base URL |
| `NEXT_PUBLIC_MINI4_PROCESSOR_ADDRESS` | `0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C` | Unified processor address |

All circuit IDs share this address and the fixed
`eval(uint256,bytes) returns(bytes)` ABI. There are no separate per-circuit
address or function-signature settings. The calculator additionally rejects a
processor address, proxy bytecode, beacon, implementation, Circuit `#6` owner,
metadata, or netlist hash that differs from the checked-in pins.

Treat every `NEXT_PUBLIC_*` value as public. Never place a private key, seed
phrase, signing credential, or secret-bearing RPC URL in these variables.

## Local development

Requirements: Node.js `>=22.13.0` and npm.

```bash
npm ci
npm run dev
```

Optional public overrides can be placed in `.env.local` using the four variables
above. The defaults require no wallet credentials.

Useful checks:

```bash
npm test
npm run test:miner
npm run lint
npm run build
```

`npm test` covers the production build, rendered HTML, fail-closed API behavior,
and a mock JSON-RPC path. The reproducible `cast` or ethers read above checks the
deployed processor independently of the website.

## Roadmap

- Keep Circuits `#1`–`#6` reproducible from public chain evidence.
- Expand arithmetic only after the corresponding circuit is deployed and
  independently verified.
- Add multiplication only after a multiplier circuit is deployed and verified.

The UI will not claim capabilities that the configured processor cannot execute.

## License

[MIT](LICENSE) © 2026 tomandpeter
