"""Shadow-miner orchestration with hard-coded read-only safety boundaries."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .formula import FormulaConstants
from .storage import StateStore
from .tapeout import (
    ELIGIBLE_PROCESSORS,
    FORMULA_URL,
    MINI4_PROCESSOR,
    PublicDataError,
    PublicHttpClient,
    fetch_circuit_market_summary,
    fetch_tasks,
    read_mini4_chain,
    scan_public_frontend,
    utc_now,
)


LOGGER = logging.getLogger("mini4_miner")


class ShadowMiner:
    def __init__(
        self,
        *,
        store: StateStore,
        client: PublicHttpClient | None = None,
        poll_seconds: int = 300,
        protocol_scan_seconds: int = 21_600,
    ):
        if poll_seconds < 30:
            raise ValueError("poll_seconds must be at least 30")
        if protocol_scan_seconds < poll_seconds:
            raise ValueError("protocol_scan_seconds cannot be shorter than poll_seconds")
        self.store = store
        self.client = client or PublicHttpClient()
        self.poll_seconds = poll_seconds
        self.protocol_scan_seconds = protocol_scan_seconds
        self.status_max_age_seconds = max(300, poll_seconds * 3)
        self._lock = threading.RLock()
        self._status: dict[str, Any] = store.load_latest() or self._starting_status()
        self._tasks: list[dict[str, Any]] = []
        self._last_protocol_scan_monotonic: float | None = None
        self._stop = threading.Event()

    @staticmethod
    def _starting_status() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "mode": "shadow_read_only",
            "status": "starting",
            "healthy": False,
            "observed_at": None,
            "fingerprint": "",
            "safety": {
                "transactions_enabled": False,
                "signer_present": False,
                "wallet_loaded": False,
                "automatic_tapeout": False,
                "automatic_claim": False,
            },
        }

    def status(self) -> dict[str, Any]:
        with self._lock:
            snapshot = json.loads(json.dumps(self._status))
        observed_at = snapshot.get("observed_at")
        age_seconds: float | None = None
        if isinstance(observed_at, str):
            try:
                observed = datetime.fromisoformat(observed_at)
                if observed.tzinfo is not None:
                    age_seconds = max(
                        0.0,
                        (datetime.now(timezone.utc) - observed).total_seconds(),
                    )
            except ValueError:
                pass
        stale = age_seconds is None or age_seconds > self.status_max_age_seconds
        snapshot["freshness"] = {
            "age_seconds": round(age_seconds, 3) if age_seconds is not None else None,
            "max_age_seconds": self.status_max_age_seconds,
            "stale": stale,
        }
        if stale and snapshot.get("healthy"):
            snapshot["healthy"] = False
            snapshot["status"] = "stale"
        return snapshot

    def tasks(self) -> list[dict[str, Any]]:
        with self._lock:
            return json.loads(json.dumps(self._tasks))

    def stop(self) -> None:
        self._stop.set()

    def poll_once(
        self,
        *,
        force_protocol_scan: bool = False,
        skip_protocol_scan: bool = False,
    ) -> dict[str, Any]:
        observed_at = utc_now()
        errors: dict[str, str] = {}

        tasks: list[dict[str, Any]] = []
        task_summary: dict[str, Any] | None = None
        try:
            tasks, task_summary = fetch_tasks(self.client)
        except PublicDataError as exc:
            errors["tasks"] = str(exc)

        market_summary: dict[str, Any] | None = None
        try:
            market_summary = fetch_circuit_market_summary(self.client)
        except PublicDataError as exc:
            errors["circuit_market"] = str(exc)

        chain_summary: dict[str, Any] | None = None
        try:
            chain_summary = read_mini4_chain(self.client)
            if chain_summary["chain_id"] != 56:
                raise PublicDataError("MINI-4 RPC returned unexpected chain id")
            if not chain_summary["code_present"]:
                raise PublicDataError("MINI-4 processor has no contract code")
        except PublicDataError as exc:
            errors["mini4_chain"] = str(exc)

        now_monotonic = time.monotonic()
        protocol_due = not skip_protocol_scan and (
            force_protocol_scan
            or self._last_protocol_scan_monotonic is None
            or now_monotonic - self._last_protocol_scan_monotonic >= self.protocol_scan_seconds
        )
        previous_protocol = self.status().get("protocol", {})
        frontend_scan = previous_protocol.get("frontend_scan")
        frontend_scanned_at = previous_protocol.get("frontend_scanned_at")
        if protocol_due:
            # Back off after failed attempts as well as successful ones; a
            # broken public bundle must not trigger a slow scan every cycle.
            self._last_protocol_scan_monotonic = now_monotonic
            try:
                frontend_scan = scan_public_frontend(self.client).as_dict()
                frontend_scanned_at = observed_at
            except PublicDataError as exc:
                errors["frontend_scan"] = str(exc)

        required_ok = task_summary is not None and chain_summary is not None
        service_status = "healthy" if required_ok and not errors else "degraded"
        if not required_ok:
            service_status = "unhealthy"

        constants = FormulaConstants()
        protocol = {
            "formula_url": FORMULA_URL,
            "formula_constants": {
                "latch_area_weight": constants.latch_area_weight,
                "latch_burn_weight": constants.latch_burn_weight,
                "depth_exponent": constants.depth_exponent,
                "quality_cap": constants.quality_cap,
            },
            "eligible_processors": list(ELIGIBLE_PROCESSORS),
            "ref_policy": "fail_closed_any_ref_ineligible",
            "ref_policy_conflict": (
                "public formula rejects every REF; current market snapshot may label some REF circuits eligible"
            ),
            "frontend_scan": frontend_scan,
            "frontend_scanned_at": frontend_scanned_at,
            "reward_contract_ready": False,
            "activation_blockers": [
                "verified reward contract address and source not published",
                "reward ABI/events and claim/register flow not published",
                "official task vectors or vector hashes not published",
                "REF eligibility conflict unresolved",
                "MINI-4 is not in the current public mining processor list",
            ],
        }

        payload: dict[str, Any] = {
            "schema_version": 1,
            "mode": "shadow_read_only",
            "status": service_status,
            "healthy": required_ok,
            "observed_at": observed_at,
            "safety": {
                "transactions_enabled": False,
                "signer_present": False,
                "wallet_loaded": False,
                "automatic_tapeout": False,
                "automatic_claim": False,
                "private_key_environment_variables_read": False,
            },
            "mini4": {
                "processor": MINI4_PROCESSOR,
                "eligible_by_current_public_rules": False,
                "chain": chain_summary,
            },
            "tasks": task_summary,
            "circuit_market": market_summary,
            "protocol": protocol,
            "research": {
                "bounded_flat_nand_search_available": True,
                "supports_ref_nodes": False,
                "automatic_task_verification_available": False,
                "reason": "official task vectors/specification are not published",
            },
            "errors": errors,
        }
        fingerprint_body = {
            "status": service_status,
            "task_sha": (task_summary or {}).get("sha256"),
            "market_sha": (market_summary or {}).get("sha256"),
            "chain_id": (chain_summary or {}).get("chain_id"),
            "code_sha": (chain_summary or {}).get("code_sha256"),
            "frontend_fingerprint": (frontend_scan or {}).get("fingerprint")
            if isinstance(frontend_scan, dict)
            else None,
            "errors": errors,
        }
        payload["fingerprint"] = hashlib.sha256(
            json.dumps(fingerprint_body, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

        changed = self.store.save(payload)
        payload["history"] = self.store.history_summary()
        payload["changed"] = changed
        with self._lock:
            self._status = payload
            if tasks:
                self._tasks = tasks
        LOGGER.info(
            "SHADOW_SCAN status=%s tasks=%s changed=%s errors=%s",
            service_status,
            (task_summary or {}).get("count"),
            changed,
            ",".join(sorted(errors)) or "none",
        )
        return self.status()

    def run_forever(self) -> None:
        first_scan = True
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                # Make health/tasks available before the slower public-bundle
                # discovery pass.  The following normal cycle performs it.
                self.poll_once(skip_protocol_scan=first_scan)
                first_scan = False
            except Exception:
                # Public-source failures are represented as degraded snapshots.
                # Programmer or persistence failures must reach systemd so its
                # restart policy can recover the process.
                LOGGER.exception("SHADOW_SCAN_UNEXPECTED")
                raise
            elapsed = time.monotonic() - started
            self._stop.wait(max(1.0, self.poll_seconds - elapsed))
