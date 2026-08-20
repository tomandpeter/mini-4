from __future__ import annotations

import unittest

from miner.netlist import NandGate, NandNetlist
from miner.search import search_nand_network


class NetlistTests(unittest.TestCase):
    def test_flat_half_adder(self) -> None:
        netlist = NandNetlist(
            n_inputs=2,
            gates=(
                NandGate(0, 1),
                NandGate(0, 2),
                NandGate(1, 2),
                NandGate(3, 4),
                NandGate(2, 2),
            ),
            outputs=(5, 6),
        )
        self.assertEqual(netlist.gate_count, 5)
        self.assertEqual(netlist.depth, 3)
        self.assertEqual(netlist.truth_tables(), (0b0110, 0b1000))
        self.assertFalse(netlist.as_dict()["contains_ref"])

    def test_rejects_forward_reference(self) -> None:
        with self.assertRaises(ValueError):
            NandNetlist(2, (NandGate(0, 2),), (2,)).validate()


class SearchTests(unittest.TestCase):
    def test_finds_nand_in_one_gate(self) -> None:
        result = search_nand_network(
            n_inputs=2,
            target_tables=(0b0111,),
            max_gates=1,
            max_states=100,
            time_limit_seconds=1,
        )
        self.assertIsNotNone(result.netlist)
        assert result.netlist is not None
        self.assertEqual(result.netlist.gate_count, 1)
        self.assertEqual(result.netlist.truth_tables(), (0b0111,))

    def test_finds_ref_free_half_adder_in_five_gates(self) -> None:
        result = search_nand_network(
            n_inputs=2,
            target_tables=(0b0110, 0b1000),
            max_gates=5,
            max_states=250_000,
            time_limit_seconds=5,
        )
        self.assertIsNotNone(result.netlist, result.as_dict())
        assert result.netlist is not None
        self.assertEqual(result.netlist.gate_count, 5)
        self.assertEqual(result.netlist.truth_tables(), (0b0110, 0b1000))


if __name__ == "__main__":
    unittest.main()
