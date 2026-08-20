from __future__ import annotations

import unittest

from miner.formula import score_candidate


class FormulaTests(unittest.TestCase):
    def test_half_adder_reference(self) -> None:
        score = score_candidate(
            local_nand=5,
            local_latch=0,
            recursive_elements=5,
            recursive_latches=0,
            depth=3,
            task_k=5,
            reference_cost=135,
            processor_coefficient=1,
        )
        self.assertEqual(score.area, 5)
        self.assertEqual(score.cost, 135)
        self.assertEqual(score.quality, 1)
        self.assertEqual(score.hashpower, 10)

    def test_sequential_reference_area_adds_latch_weight(self) -> None:
        score = score_candidate(
            local_nand=4,
            local_latch=1,
            recursive_elements=5,
            recursive_latches=1,
            depth=3,
            task_k=5,
            reference_cost=297,
            processor_coefficient=1,
        )
        self.assertEqual(score.area, 11)
        self.assertEqual(score.cost, 297)

    def test_quality_is_clamped(self) -> None:
        high = score_candidate(
            local_nand=1,
            local_latch=0,
            recursive_elements=1,
            recursive_latches=0,
            depth=1,
            task_k=10,
            reference_cost=1000,
            processor_coefficient=1,
        )
        low = score_candidate(
            local_nand=100,
            local_latch=0,
            recursive_elements=100,
            recursive_latches=0,
            depth=10,
            task_k=10,
            reference_cost=1,
            processor_coefficient=1,
        )
        self.assertEqual(high.quality, 4)
        self.assertEqual(low.quality, 0.25)

    def test_rejects_zero_area(self) -> None:
        with self.assertRaises(ValueError):
            score_candidate(
                local_nand=0,
                local_latch=0,
                recursive_elements=0,
                recursive_latches=0,
                depth=0,
                task_k=1,
                reference_cost=1,
                processor_coefficient=1,
            )


if __name__ == "__main__":
    unittest.main()
