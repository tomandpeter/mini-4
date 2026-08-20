"""Small flat NAND-netlist model used by the bounded research search.

Source indexes ``0..n_inputs-1`` are input pins.  Source indexes beginning at
``n_inputs`` refer to gates in order.  There is intentionally no REF node.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class NandGate:
    left: int
    right: int


@dataclass(frozen=True)
class NandNetlist:
    n_inputs: int
    gates: tuple[NandGate, ...]
    outputs: tuple[int, ...]

    def validate(self) -> None:
        if isinstance(self.n_inputs, bool) or self.n_inputs <= 0:
            raise ValueError("n_inputs must be a positive integer")
        for index, gate in enumerate(self.gates):
            limit = self.n_inputs + index
            if gate.left < 0 or gate.right < 0:
                raise ValueError("gate sources cannot be negative")
            if gate.left >= limit or gate.right >= limit:
                raise ValueError("gate source must refer to an earlier signal")
        final_limit = self.n_inputs + len(self.gates)
        if not self.outputs:
            raise ValueError("at least one output is required")
        if any(source < 0 or source >= final_limit for source in self.outputs):
            raise ValueError("output source is outside the netlist")

    @property
    def gate_count(self) -> int:
        return len(self.gates)

    def signal_depths(self) -> tuple[int, ...]:
        self.validate()
        depths = [0] * self.n_inputs
        for gate in self.gates:
            depths.append(1 + max(depths[gate.left], depths[gate.right]))
        return tuple(depths)

    @property
    def depth(self) -> int:
        depths = self.signal_depths()
        return max(depths[source] for source in self.outputs)

    def evaluate(self, inputs: Iterable[int]) -> tuple[int, ...]:
        self.validate()
        values = list(inputs)
        if len(values) != self.n_inputs or any(value not in (0, 1) for value in values):
            raise ValueError("inputs must contain exactly n_inputs bits")
        for gate in self.gates:
            values.append(1 - (values[gate.left] & values[gate.right]))
        return tuple(values[source] for source in self.outputs)

    def truth_tables(self) -> tuple[int, ...]:
        """Pack output truth tables into integers by little-endian assignment.

        Assignment index ``i`` supplies input bit ``j`` as ``(i >> j) & 1``.
        Output at assignment ``i`` is stored in bit ``i``.
        """

        packed = [0] * len(self.outputs)
        for assignment in range(1 << self.n_inputs):
            inputs = tuple(
                (assignment >> bit_index) & 1
                for bit_index in range(self.n_inputs)
            )
            for output_index, value in enumerate(self.evaluate(inputs)):
                packed[output_index] |= value << assignment
        return tuple(packed)

    def as_dict(self) -> dict[str, Any]:
        return {
            "n_inputs": self.n_inputs,
            "gates": [asdict(gate) for gate in self.gates],
            "outputs": list(self.outputs),
            "gate_count": self.gate_count,
            "depth": self.depth,
            "truth_tables": list(self.truth_tables()),
            "contains_ref": False,
        }
