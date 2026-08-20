"""MINI-4 Proof-of-Design shadow miner.

The package is deliberately read-only.  It contains no signer, private-key
loader, transaction builder, or contract write path.
"""

from .formula import CandidateScore, FormulaConstants, score_candidate

__all__ = ["CandidateScore", "FormulaConstants", "score_candidate"]
