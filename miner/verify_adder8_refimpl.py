"""Verify TapeOut's pinned REF-free 8-bit adder reference implementation.

This module is deliberately read-only: it downloads public JSON, decodes the
7-byte gate cells, and evaluates the circuit locally.  It never connects a
wallet or submits a transaction.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Iterable
from urllib.request import Request, urlopen


REFIMPL_URL = "https://tapeout.net/pod/pod-refimpl.json"
TASK_KEY = "38"
EXPECTED_SHA256 = "fcabd68bd2aecc2b53b3f660ca7aab8defa8d67c929e1c79ca763c9008ff4933"
NAND_OPCODE = 0


@dataclass(frozen=True)
class GateCell:
    opcode: int
    left: int
    right: int
    output: int


def decode_netlist(encoded: str, n_inputs: int) -> tuple[GateCell, ...]:
    """Decode ``opcode:uint8, left:uint24be, right:uint24be`` cells."""

    if not encoded.startswith("0x"):
        raise ValueError("netlist must be 0x-prefixed")
    raw = bytes.fromhex(encoded[2:])
    if len(raw) % 7:
        raise ValueError("netlist length must be a multiple of seven bytes")

    cells = []
    for index in range(len(raw) // 7):
        offset = index * 7
        output = 2 + n_inputs + index
        cell = GateCell(
            opcode=raw[offset],
            left=int.from_bytes(raw[offset + 1 : offset + 4], "big"),
            right=int.from_bytes(raw[offset + 4 : offset + 7], "big"),
            output=output,
        )
        if cell.left >= output or cell.right >= output:
            raise ValueError(f"gate {index} has a forward or invalid reference")
        cells.append(cell)
    return tuple(cells)


def evaluate_nand_cells(
    cells: Iterable[GateCell], input_bits: Iterable[int], n_outputs: int
) -> tuple[int, ...]:
    bits = tuple(input_bits)
    if any(bit not in (0, 1) for bit in bits):
        raise ValueError("inputs must be bits")
    signals = [0, 1, *bits]
    cells = tuple(cells)
    if n_outputs <= 0 or n_outputs > len(cells):
        raise ValueError("invalid output count")

    for cell in cells:
        if cell.opcode != NAND_OPCODE:
            raise ValueError(f"non-NAND opcode {cell.opcode} at source {cell.output}")
        if cell.output != len(signals):
            raise ValueError("non-contiguous gate output")
        signals.append(1 - (signals[cell.left] & signals[cell.right]))
    return tuple(signals[cell.output] for cell in cells[-n_outputs:])


def verify_all_addends(cells: tuple[GateCell, ...], width: int) -> int:
    cases = 0
    for a in range(1 << width):
        for b in range(1 << width):
            inputs = tuple((a >> bit) & 1 for bit in range(width)) + tuple(
                (b >> bit) & 1 for bit in range(width)
            )
            outputs = evaluate_nand_cells(cells, inputs, width + 1)
            actual = sum(bit << index for index, bit in enumerate(outputs))
            expected = a + b
            if actual != expected:
                raise AssertionError(
                    f"A={a}, B={b}: got {actual} ({outputs}), expected {expected}"
                )
            cases += 1
    return cases


def fetch_task(url: str = REFIMPL_URL) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "mini4-refimpl-verifier/1.0"})
    with urlopen(request, timeout=30) as response:
        document = json.load(response)
    task = document.get(TASK_KEY)
    if not isinstance(task, dict):
        raise ValueError(f"task key {TASK_KEY} is missing")
    return task


def verify_task(task: dict[str, Any]) -> dict[str, Any]:
    expected_metadata = {
        "taskId": 38,
        "srcId": 39,
        "kind": "comb",
        "nIn": 16,
        "nOut": 9,
        "nand": 68,
        "latch": 0,
        "gates": 68,
    }
    for key, expected in expected_metadata.items():
        if task.get(key) != expected:
            raise AssertionError(f"{key}: got {task.get(key)!r}, expected {expected!r}")

    encoded = task.get("netlist")
    if not isinstance(encoded, str):
        raise ValueError("task netlist is missing")
    raw = bytes.fromhex(encoded[2:])
    digest = hashlib.sha256(raw).hexdigest()
    if digest != EXPECTED_SHA256:
        raise AssertionError(f"netlist SHA-256 changed: {digest}")

    cells = decode_netlist(encoded, task["nIn"])
    if len(cells) != task["gates"]:
        raise AssertionError("decoded gate count differs from metadata")
    opcodes = sorted({cell.opcode for cell in cells})
    if opcodes != [NAND_OPCODE]:
        raise AssertionError(f"expected only NAND cells, got opcodes {opcodes}")

    cases = verify_all_addends(cells, width=8)
    output_cells = cells[-task["nOut"] :]
    return {
        "status": "verified",
        "task": {key: task[key] for key in ("taskId", "srcId", "name", "kind")},
        "sha256": digest,
        "netlist_bytes": len(raw),
        "gate_encoding": "uint8 opcode + uint24be left + uint24be right",
        "nand": len(cells),
        "latch": 0,
        "contains_ref": False,
        "input_mapping": {
            "bits_0_to_7": "A0..A7 (little-endian bits; sources 2..9)",
            "bits_8_to_15": "B0..B7 (little-endian bits; sources 10..17)",
        },
        "output_mapping": {
            "bits_0_to_7": "SUM0..SUM7 (little-endian bits; sources 77..84)",
            "bit_8": "CARRY_OUT (source 85)",
        },
        "output_cells": [asdict(cell) for cell in output_cells],
        "exhaustive_cases": cases,
        "failures": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=REFIMPL_URL)
    args = parser.parse_args()
    print(json.dumps(verify_task(fetch_task(args.url)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
