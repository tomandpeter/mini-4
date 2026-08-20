from __future__ import annotations

import unittest

from miner.tapeout import (
    MAX_CANDIDATE_ADDRESS_SAMPLE,
    PublicDataError,
    _NoRedirectHandler,
    extract_asset_paths,
    read_mini4_chain,
    scan_public_frontend,
    validate_tasks_document,
)


def task(task_id: int = 1) -> dict[str, object]:
    return {
        "id": task_id,
        "name": "NAND",
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


class TaskValidationTests(unittest.TestCase):
    def test_valid_document(self) -> None:
        tasks = validate_tasks_document({"total": 1, "tasks": [task()]})
        self.assertEqual(tasks[0]["id"], 1)

    def test_accepts_self_running_sequential_task(self) -> None:
        value = task()
        value.update({"kind": "seq", "nIn": 0, "cycles": 8})
        tasks = validate_tasks_document({"total": 1, "tasks": [value]})
        self.assertEqual(tasks[0]["nIn"], 0)

    def test_rejects_total_mismatch(self) -> None:
        with self.assertRaises(PublicDataError):
            validate_tasks_document({"total": 2, "tasks": [task()]})

    def test_rejects_duplicate_id(self) -> None:
        with self.assertRaises(PublicDataError):
            validate_tasks_document({"total": 2, "tasks": [task(), task()]})

    def test_extracts_only_js_assets(self) -> None:
        text = 'import("/assets/Formula-abc_1.js");"assets/chain-def.js";"/assets/x.css"'
        self.assertEqual(
            extract_asset_paths(text),
            {"assets/Formula-abc_1.js", "assets/chain-def.js"},
        )

    def test_redirects_are_rejected_before_following(self) -> None:
        with self.assertRaises(PublicDataError):
            _NoRedirectHandler().redirect_request(
                None, None, 302, "Found", {}, "https://127.0.0.1/private"
            )

    def test_frontend_candidate_address_sample_is_bounded(self) -> None:
        addresses = "".join(f"0x{value:040x}" for value in range(1, 50))

        class AddressClient:
            def get_bytes(self, url: str, *, max_bytes: int, allowed_hosts: object = None) -> bytes:
                del max_bytes, allowed_hosts
                if url == "https://tapeout.net/":
                    return b'<script src="/assets/index-addresses.js"></script>'
                return ("Proof of Design commitDesign " + addresses).encode()

        scan = scan_public_frontend(AddressClient())
        self.assertEqual(scan.candidate_address_occurrences, 49)
        self.assertEqual(len(scan.candidate_addresses), MAX_CANDIDATE_ADDRESS_SAMPLE)

    def test_rejects_malformed_rpc_hex_as_public_data_error(self) -> None:
        class MalformedRpcClient:
            def post_json(self, url: str, payload: dict[str, object], **_kwargs: object) -> dict[str, object]:
                result = "0xzz" if payload["method"] == "eth_blockNumber" else "0x38"
                return {"jsonrpc": "2.0", "id": payload["id"], "result": result}

        with self.assertRaises(PublicDataError):
            read_mini4_chain(MalformedRpcClient())

    def test_rejects_mismatched_rpc_id(self) -> None:
        class WrongIdRpcClient:
            def post_json(self, _url: str, _payload: dict[str, object], **_kwargs: object) -> dict[str, object]:
                return {"jsonrpc": "2.0", "id": 999, "result": "0x38"}

        with self.assertRaises(PublicDataError):
            read_mini4_chain(WrongIdRpcClient())


if __name__ == "__main__":
    unittest.main()
