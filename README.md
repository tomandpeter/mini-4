# MINI-4

**A Calculator Built On-Chain — one bit at a time.**

MINI-4 is a small, honest interface for experimenting with a deployed logic
processor on BNB Smart Chain mainnet. The current version exposes NAND, NOT,
AND, XOR, and a 1-bit half adder through one processor contract.

The browser calls MINI-4's same-origin API, which sends a read-only `eth_call`
to a BNB Chain RPC endpoint. A node evaluates deployed contract bytecode against
current chain state and returns the result. No wallet, signer, transaction, or
gas payment is required: `eth_call` is not mined and does not change chain
state.

MINI-4 does **not** substitute browser-side arithmetic when a chain call fails.
If the RPC, processor configuration, chain ID, or returned data is invalid, the
calculator fails closed instead of presenting a fabricated result.

## Verified BNB mainnet processor

MINI-4 uses one processor for all five circuit IDs:

| Property | Value |
| --- | --- |
| Network | BNB Smart Chain mainnet |
| Chain ID | `56` |
| Processor | [`0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C`](https://bscscan.com/address/0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C) |
| Read ABI | `eval(uint256,bytes) returns(bytes)` |

A live read on 2026-08-20 confirmed code at this address and returned `0x02`
for `eval(5, 0x03)`, the packed result of `1 + 1`.

The processor address currently contains beacon-proxy bytecode rather than an
immutable implementation. At BNB block `117056298`, its beacon
`0xf8d6d8eb894d6971c8976ad8b4971cbefe028156` resolved to implementation
`0xb9e2f952b67c54f28a8fae544ce5a15ba31761de`; the beacon also exposes an
owner and an `upgradeTo(address)` route. The website therefore records the
block used for every result and describes behavior as verified on-chain, not as
unchangeable forever.

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

Inputs and outputs use little-endian bit packing: bit 0 is the least-significant
bit. For two-input circuits, pack `A` into bit 0 and `B` into bit 1:

```text
packed input = A | (B << 1)
```

The returned `bytes` use the same ordering. Circuits 1–4 return their result in
bit 0. Circuit 5 returns `SUM` in bit 0 and `CARRY` in bit 1.

For `A = 1` and `B = 1`:

```text
input  = 0b00000011 = 0x03
output = 0b00000010 = 0x02

SUM   = output bit 0 = 0
CARRY = output bit 1 = 1
binary result         = 10
decimal result        = 2
```

The current UI intentionally accepts only single-bit inputs. It does not yet
support arbitrary arithmetic, 0–255 addition, or multiplication.

## Reproduce the chain call

### Foundry `cast`

This is a provider-only read; no private key or wallet flag is needed.

```bash
cast call \
  0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C \
  "eval(uint256,bytes)(bytes)" \
  5 \
  0x03 \
  --rpc-url https://bsc-dataseed.binance.org
```

Expected decoded return:

```text
0x02
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

const circuitId = 5n;
const A = 1;
const B = 1;
const input = hexlify(Uint8Array.of(A | (B << 1))); // 0x03

const rawOutput = await processor.eval(circuitId, input);
const [packedOutput = 0] = getBytes(rawOutput);

const sum = packedOutput & 1;
const carry = (packedOutput >> 1) & 1;

console.log({ rawOutput, sum, carry });
// { rawOutput: "0x02", sum: 0, carry: 1 }
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

The five circuit IDs share this address and the fixed
`eval(uint256,bytes) returns(bytes)` ABI. There are no separate per-circuit
address or function-signature settings.

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
npm run lint
npm run build
```

`npm test` covers the production build, rendered HTML, fail-closed API behavior,
and a mock JSON-RPC path. The reproducible `cast` or ethers read above checks the
deployed processor independently of the website.

## Roadmap

- Keep the five current circuit IDs reproducible from public chain evidence.
- Add an 8-bit adder only after a corresponding circuit is deployed and
  verified, enabling 0–255 addition.
- Add multiplication only after a multiplier circuit is deployed and verified.

The UI will not claim capabilities that the configured processor cannot execute.

## License

[MIT](LICENSE) © 2026 tomandpeter
