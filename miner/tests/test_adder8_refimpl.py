from __future__ import annotations

import unittest

from miner.verify_adder8_refimpl import decode_netlist, verify_all_addends


class Adder8RefimplVerifierTests(unittest.TestCase):
    def test_decodes_and_exhaustively_checks_a_one_bit_adder(self) -> None:
        # Five protocol-format NAND cells. Inputs are sources 2 and 3; the
        # final two cells are SUM and CARRY_OUT, matching TapeOut output order.
        encoded = (
            "0x"
            "00000002000003"
            "00000002000004"
            "00000003000004"
            "00000005000006"
            "00000004000004"
        )
        cells = decode_netlist(encoded, n_inputs=2)
        self.assertEqual(len(cells), 5)
        self.assertEqual(verify_all_addends(cells, width=1), 4)

    def test_rejects_forward_reference(self) -> None:
        with self.assertRaisesRegex(ValueError, "forward"):
            decode_netlist("0x00000002000004", n_inputs=2)


if __name__ == "__main__":
    unittest.main()
