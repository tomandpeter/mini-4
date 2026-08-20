# MINI-4 PoD Shadow Miner

This directory is the always-on, **read-only** research service for MINI-4.
It watches public TapeOut task and frontend data, verifies that the MINI-4
processor still has code on BNB Chain, reproduces the published PoD scoring
formula, and exposes a local status dashboard.

It is deliberately not a transaction bot:

- no wallet or private-key loader;
- no signer or raw-transaction builder;
- no `commitDesign`, tape-out, register, claim, transfer, or approval call;
- no access to retired trading credentials;
- no claim that MINI-4 is currently mining-eligible or earning rewards.

As checked on 2026-08-21, the official public frontend publishes 281 task
metadata records but not their verification vectors. It also does not publish a
verifiable PoD reward contract address/ABI/claim flow. Current public mining
coefficients name Behemoth and TapeOut, not MINI-4. The public formula rejects
all netlists containing REF, while the circuit-market snapshot can label some
REF circuits eligible; this service therefore fails closed and treats every REF
candidate as ineligible until verified contract source resolves the conflict.

## Commands

Only Python 3.9+ and the standard library are required.

```bash
# Fetch public tasks, market snapshot, BNB state, and bounded frontend signals.
python3 -m miner once --data-dir /tmp/mini4-shadow

# Run the localhost-only dashboard.
python3 -m miner run --data-dir /tmp/mini4-shadow --bind 127.0.0.1 --port 8787

# Reproduce the public Half Adder reference score on TapeOut.
python3 -m miner score \
  --local-nand 5 \
  --recursive-elements 5 \
  --depth 3 \
  --task-k 5 \
  --reference-cost 135 \
  --processor tapeout

# Bounded exhaustive search for a flat, REF-free NAND half adder.
python3 -m miner search --profile half-adder --max-gates 5
```

Truth-table search packs assignments little-endian. With two inputs, bits 0–3
represent `00`, `01`, `10`, and `11`; XOR is `0b0110` and AND is `0b1000`.
The search is intentionally limited by gate count, elapsed time, and explored
states so it cannot monopolize a small VPS.

## HTTP status

The production unit binds only to `127.0.0.1:8787`:

- `/` — small human-readable dashboard;
- `/healthz` — required public-source health;
- `/api/status` — complete read-only status and blockers;
- `/api/tasks?limit=20` — currently published task metadata;
- `/metrics` — small Prometheus-compatible metric set.

Use an SSH tunnel for access. Do not open port 8787 directly to the internet.

## State

`latest.json` and a bounded SQLite snapshot history live in the configured data
directory. Production uses `/var/lib/mini4-pod-miner`; releases under `/opt` are
read-only and never contain wallet or exchange credentials.

## Validation

```bash
python3 -m compileall -q miner
python3 -m unittest discover -s miner/tests -t . -v
```

The systemd template in `deploy/` uses a dedicated non-login user, filesystem
protection, a 256MB memory limit, a 70% single-CPU quota, and automatic restart
on failure.
