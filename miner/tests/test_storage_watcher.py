from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from miner.storage import StateStore
from miner.tapeout import BSC_RPC_URL, CIRCUIT_MARKET_URL, TASKS_URL
from miner.watcher import ShadowMiner


class FakeClient:
    def get_json(self, url: str, *, max_bytes: int = 2_000_000) -> Any:
        del max_bytes
        if url == TASKS_URL:
            return {
                "total": 1,
                "tasks": [
                    {
                        "id": 4,
                        "name": "与非门 NAND",
                        "tier": "入门",
                        "group": "logic",
                        "kind": "comb",
                        "nIn": 2,
                        "nOut": 1,
                        "cycles": 1,
                        "g": 1,
                        "d": 1,
                        "K": 1,
                        "C": 1,
                    }
                ],
            }
        if url == CIRCUIT_MARKET_URL:
            return {
                "generatedAt": "2026-08-21T00:00:00Z",
                "block": 123,
                "marketAddr": "0x1111111111111111111111111111111111111111",
                "maxId": 1,
                "listings": [],
            }
        raise AssertionError(url)

    def get_bytes(self, url: str, *, max_bytes: int, allowed_hosts: object = None) -> bytes:
        del max_bytes, allowed_hosts
        if url == "https://tapeout.net/":
            return b'<script src="/assets/index-test.js"></script>'
        if url == "https://tapeout.net/assets/index-test.js":
            return b'const text="Proof of Design commitDesign";'
        raise AssertionError(url)

    def post_json(self, url: str, payload: dict[str, Any], *, allowed_hosts: object, max_bytes: int = 1_000_000) -> Any:
        del allowed_hosts, max_bytes
        self.assert_rpc_url(url)
        method = payload["method"]
        result = {
            "eth_chainId": "0x38",
            "eth_blockNumber": "0x7b",
            "eth_getCode": "0x6000",
        }[method]
        return {"jsonrpc": "2.0", "id": payload["id"], "result": result}

    @staticmethod
    def assert_rpc_url(url: str) -> None:
        if url != BSC_RPC_URL:
            raise AssertionError(url)


class StoreWatcherTests(unittest.TestCase):
    def test_store_retains_only_changed_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            payload = {
                "observed_at": "2026-08-21T00:00:00Z",
                "fingerprint": "a",
                "healthy": True,
                "tasks": {"count": 1},
            }
            self.assertTrue(store.save(payload))
            self.assertFalse(store.save(payload))
            self.assertEqual(store.history_summary()["snapshots"], 1)

    def test_store_accepts_missing_public_task_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = StateStore(temporary)
            payload = {
                "observed_at": "2026-08-21T00:00:00Z",
                "fingerprint": "offline",
                "healthy": False,
                "tasks": None,
            }
            self.assertTrue(store.save(payload))
            self.assertEqual(store.history_summary()["snapshots"], 1)

    def test_watcher_is_hardcoded_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            miner = ShadowMiner(
                store=StateStore(Path(temporary)),
                client=FakeClient(),
                poll_seconds=30,
                protocol_scan_seconds=30,
            )
            status = miner.poll_once(force_protocol_scan=True)
            self.assertTrue(status["healthy"])
            self.assertEqual(status["tasks"]["count"], 1)
            self.assertFalse(status["safety"]["transactions_enabled"])
            self.assertFalse(status["safety"]["wallet_loaded"])
            self.assertFalse(status["protocol"]["reward_contract_ready"])
            self.assertFalse(status["mini4"]["eligible_by_current_public_rules"])

    def test_old_successful_status_becomes_unhealthy_when_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            miner = ShadowMiner(
                store=StateStore(Path(temporary)),
                client=FakeClient(),
                poll_seconds=30,
                protocol_scan_seconds=30,
            )
            miner._status = {
                "status": "healthy",
                "healthy": True,
                "observed_at": "2020-01-01T00:00:00+00:00",
            }
            status = miner.status()
            self.assertFalse(status["healthy"])
            self.assertEqual(status["status"], "stale")
            self.assertTrue(status["freshness"]["stale"])


if __name__ == "__main__":
    unittest.main()
