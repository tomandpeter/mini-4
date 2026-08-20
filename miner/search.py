"""Bounded exhaustive search for very small flat NAND networks.

This is a research aid, not a profitability engine.  Limits are mandatory so
the search cannot monopolize the retired 1-vCPU trading VPS.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations_with_replacement
from time import monotonic
from typing import Iterable

from .netlist import NandGate, NandNetlist


BUILTIN_TARGETS: dict[str, tuple[int, tuple[int, ...]]] = {
    # For two inputs, truth-table bits correspond to 00, 01, 10, 11.
    "nand": (2, (0b0111,)),
    "and": (2, (0b1000,)),
    "or": (2, (0b1110,)),
    "xor": (2, (0b0110,)),
    "half-adder": (2, (0b0110, 0b1000)),
}


@dataclass(frozen=True)
class SearchResult:
    netlist: NandNetlist | None
    explored_states: int
    elapsed_seconds: float
    stopped_reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "found": self.netlist is not None,
            "netlist": self.netlist.as_dict() if self.netlist else None,
            "explored_states": self.explored_states,
            "elapsed_seconds": round(self.elapsed_seconds, 6),
            "stopped_reason": self.stopped_reason,
        }


@dataclass(frozen=True)
class _State:
    gates: tuple[NandGate, ...]
    tables: tuple[int, ...]
    depths: tuple[int, ...]


def input_truth_tables(n_inputs: int) -> tuple[int, ...]:
    if isinstance(n_inputs, bool) or not 1 <= n_inputs <= 4:
        raise ValueError("bounded search supports 1 to 4 inputs")
    rows = 1 << n_inputs
    return tuple(
        sum(((assignment >> bit_index) & 1) << assignment for assignment in range(rows))
        for bit_index in range(n_inputs)
    )


def search_nand_network(
    *,
    n_inputs: int,
    target_tables: Iterable[int],
    max_gates: int,
    max_states: int = 250_000,
    time_limit_seconds: float = 5.0,
) -> SearchResult:
    """Find a minimum-gate flat network for one or more output tables."""

    inputs = input_truth_tables(n_inputs)
    rows = 1 << n_inputs
    mask = (1 << rows) - 1
    targets = tuple(target_tables)
    if not targets or any(
        isinstance(target, bool) or not isinstance(target, int) or target < 0 or target > mask
        for target in targets
    ):
        raise ValueError("target_tables must contain packed tables within the input mask")
    if isinstance(max_gates, bool) or not 0 <= max_gates <= 10:
        raise ValueError("max_gates must be between 0 and 10")
    if max_states <= 0 or time_limit_seconds <= 0:
        raise ValueError("search limits must be positive")

    started = monotonic()
    initial = _State(gates=(), tables=inputs, depths=(0,) * n_inputs)
    frontier = [initial]
    explored = 0

    def result_for(state: _State, reason: str) -> SearchResult | None:
        table_to_source: dict[int, int] = {}
        for source, table in enumerate(state.tables):
            table_to_source.setdefault(table, source)
        if not all(target in table_to_source for target in targets):
            return None
        netlist = NandNetlist(
            n_inputs=n_inputs,
            gates=state.gates,
            outputs=tuple(table_to_source[target] for target in targets),
        )
        return SearchResult(netlist, explored, monotonic() - started, reason)

    found = result_for(initial, "found")
    if found:
        return found

    for _gate_count in range(1, max_gates + 1):
        next_frontier: list[_State] = []
        seen: set[tuple[tuple[int, int], ...]] = set()
        for state in frontier:
            if monotonic() - started >= time_limit_seconds:
                return SearchResult(None, explored, monotonic() - started, "time_limit")
            for left, right in combinations_with_replacement(range(len(state.tables)), 2):
                explored += 1
                if explored > max_states:
                    return SearchResult(None, explored, monotonic() - started, "state_limit")
                table = (~(state.tables[left] & state.tables[right])) & mask
                depth = 1 + max(state.depths[left], state.depths[right])

                # A duplicate truth table cannot add a new wire-level capability.
                if table in state.tables:
                    continue

                new_state = _State(
                    gates=state.gates + (NandGate(left=left, right=right),),
                    tables=state.tables + (table,),
                    depths=state.depths + (depth,),
                )
                generated = tuple(
                    sorted(zip(new_state.tables[n_inputs:], new_state.depths[n_inputs:]))
                )
                if generated in seen:
                    continue
                seen.add(generated)

                found = result_for(new_state, "found")
                if found:
                    return found
                next_frontier.append(new_state)
        frontier = next_frontier
        if not frontier:
            break

    return SearchResult(None, explored, monotonic() - started, "max_gates")
