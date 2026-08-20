"""Pure Proof-of-Design scoring helpers.

Constants and equations mirror the public TapeOut formula page checked on
2026-08-21.  Keeping this module pure makes it possible to test candidate
metadata without a wallet, RPC connection, or network request.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite
from typing import Any


@dataclass(frozen=True)
class FormulaConstants:
    latch_area_weight: int = 6
    latch_burn_weight: int = 1
    depth_exponent: int = 3
    quality_cap: float = 4.0


@dataclass(frozen=True)
class CandidateScore:
    workmanship: int
    area: int
    cost: int
    quality: float
    hashpower: float
    processor_coefficient: float

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _non_negative_int(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def score_candidate(
    *,
    local_nand: int,
    local_latch: int,
    recursive_elements: int,
    recursive_latches: int,
    depth: int,
    task_k: float,
    reference_cost: float,
    processor_coefficient: float,
    constants: FormulaConstants = FormulaConstants(),
) -> CandidateScore:
    """Return ``C``, ``q`` and ``H`` for candidate metadata.

    ``recursive_elements`` includes every primitive in the recursively
    expanded design.  The formula adds six extra area units for each LATCH;
    this reproduces the public sequential-task reference costs.
    """

    local_nand = _non_negative_int("local_nand", local_nand)
    local_latch = _non_negative_int("local_latch", local_latch)
    recursive_elements = _non_negative_int(
        "recursive_elements", recursive_elements
    )
    recursive_latches = _non_negative_int(
        "recursive_latches", recursive_latches
    )
    depth = _non_negative_int("depth", depth)

    if recursive_latches > recursive_elements:
        raise ValueError("recursive_latches cannot exceed recursive_elements")
    if recursive_elements == 0:
        raise ValueError("a candidate must contain at least one primitive")
    if not isfinite(task_k) or task_k < 0:
        raise ValueError("task_k must be finite and non-negative")
    if not isfinite(reference_cost) or reference_cost <= 0:
        raise ValueError("reference_cost must be finite and positive")
    if not isfinite(processor_coefficient) or processor_coefficient <= 0:
        raise ValueError("processor_coefficient must be finite and positive")

    workmanship = (
        local_nand + constants.latch_burn_weight * local_latch
    )
    area = (
        recursive_elements
        + constants.latch_area_weight * recursive_latches
    )
    cost = area * max(depth, 1) ** constants.depth_exponent
    quality = max(
        1.0 / constants.quality_cap,
        min(reference_cost / cost, constants.quality_cap),
    )
    hashpower = (workmanship + task_k * quality) * processor_coefficient

    return CandidateScore(
        workmanship=workmanship,
        area=area,
        cost=cost,
        quality=quality,
        hashpower=hashpower,
        processor_coefficient=processor_coefficient,
    )
