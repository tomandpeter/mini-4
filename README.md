# MINI-4

**A Calculator Built On-Chain — one bit at a time.**

MINI-4 is a small, honest interface for experimenting with deployed logic
circuits on BNB Chain. The current version supports NAND, NOT, AND, XOR, and a
1-bit half adder.

The browser calls MINI-4's same-origin API, which sends a read-only `eth_call`
to the configured BNB Chain RPC endpoint. A node evaluates the deployed
contract bytecode against current chain state and returns the result. No wallet,
transaction, signature, or gas payment is required because `eth_call` is not
mined and does not change chain state.

MINI-4 does **not** pretend that browser-side arithmetic is contract execution.
If the RPC or required contract configuration is missing or invalid, the
on-chain controls fail closed instead of producing a JavaScript fallback result.

## Current scope

| Circuit | Operation | Inputs | Result |
| --- | --- | --- | --- |
| #1 | NAND | A, B | 1 bit |
| #2 | NOT | A | 1 bit |
| #3 | AND | A, B | 1 bit |
| #4 | XOR | A, B | 1 bit |
| #5 | Half adder | A, B | `SUM` and `CARRY` |

For example, Circuit #5 can evaluate `1 + 1` as `SUM = 0`, `CARRY = 1`, or
binary `10` (decimal `2`). Inputs are intentionally limited to single bits.
MINI-4 does not yet support arbitrary arithmetic, 0–255 addition, or
multiplication.

## How it works

```text
bit input in the browser
        ↓
same-origin MINI-4 API
        ↓
read-only eth_call through the configured BNB Chain RPC
        ↓
deployed circuit contract
        ↓
decoded contract result in the browser
```

The network, contract address, and exact callable function signature are all
explicit configuration. They must refer to the same deployment network.

## Configuration

Copy the checked-in template and fill it with browser-safe public values:

```bash
cp .env.example .env.local
```

Network configuration:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_MINI4_CHAIN_ID` | Numeric chain ID for the BNB Chain network containing the deployments |
| `NEXT_PUBLIC_MINI4_RPC_URL` | Public, non-secret RPC endpoint used for `eth_call` |
| `NEXT_PUBLIC_MINI4_EXPLORER_URL` | Explorer base URL for contract links |

Circuit configuration:

| Circuit | Address variable | Function-signature variable |
| --- | --- | --- |
| NAND | `NEXT_PUBLIC_MINI4_NAND_ADDRESS` | `NEXT_PUBLIC_MINI4_NAND_SIGNATURE` |
| NOT | `NEXT_PUBLIC_MINI4_NOT_ADDRESS` | `NEXT_PUBLIC_MINI4_NOT_SIGNATURE` |
| AND | `NEXT_PUBLIC_MINI4_AND_ADDRESS` | `NEXT_PUBLIC_MINI4_AND_SIGNATURE` |
| XOR | `NEXT_PUBLIC_MINI4_XOR_ADDRESS` | `NEXT_PUBLIC_MINI4_XOR_SIGNATURE` |
| Half adder | `NEXT_PUBLIC_MINI4_HALF_ADDER_ADDRESS` | `NEXT_PUBLIC_MINI4_HALF_ADDER_SIGNATURE` |

The template defaults to `nand(bool,bool)`, `not(bool)`, `and(bool,bool)`,
`xor(bool,bool)`, and `halfAdder(bool,bool)`. Each signature must exactly match
the callable function in that deployed contract's ABI. Treat every
`NEXT_PUBLIC_*` value as public information. Use a public, rate-limited RPC URL;
never put a private key, wallet seed, signing credential, or secret RPC token in
these variables.

## Local development

Requirements: Node.js `>=22.13.0` and npm.

```bash
npm ci
cp .env.example .env.local
# Add the public deployment configuration to .env.local.
npm run dev
```

Useful checks:

```bash
npm test
npm run lint
npm run build
```

`npm test` runs the production build, rendered-HTML checks, fail-closed API
checks, and a mock JSON-RPC success path that verifies `eth_chainId`,
`eth_blockNumber`, `eth_call`, calldata, raw return data, and decoded output.
Verifying a real deployment additionally requires a working public RPC and
published contract evidence.

## Contract evidence

No deployment address is committed to this public template. Before presenting a
deployment as verified, replace the placeholders below with independently
checkable public evidence and ensure it matches the production configuration.

| Circuit | Contract address | Explorer page | Deployment transaction | Published ABI/source |
| --- | --- | --- | --- | --- |
| #1 NAND | TBD | TBD | TBD | TBD |
| #2 NOT | TBD | TBD | TBD | TBD |
| #3 AND | TBD | TBD | TBD | TBD |
| #4 XOR | TBD | TBD | TBD | TBD |
| #5 Half adder | TBD | TBD | TBD | TBD |

An explorer link proves which bytecode exists at an address. Reproducible ABI
and source information are still needed to show what that bytecode is intended
to compute.

## Roadmap

- Publish explorer links, deployment transactions, ABI/source evidence, and
  reproducible live-call examples for Circuits #1–#5.
- Add an 8-bit adder after its contracts are deployed, enabling 0–255 addition.
- Add multiplication only after a multiplier circuit is deployed and verified.

The UI will not claim those capabilities before their corresponding deployed
circuits exist.

## License

[MIT](LICENSE) © 2026 tomandpeter
