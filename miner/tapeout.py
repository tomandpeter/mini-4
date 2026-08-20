"""Read-only public data adapters for TapeOut and BNB Smart Chain."""

from __future__ import annotations

import hashlib
import json
import re
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


TAPEOUT_HOME_URL = "https://tapeout.net/"
TASKS_URL = "https://tapeout.net/tasks.json"
CIRCUIT_MARKET_URL = "https://tapeout.net/circuit-market.json"
FORMULA_URL = "https://tapeout.net/#formula"
MINI4_PROCESSOR = "0x6Eefc633e4E0cBDEe88919A48776a0Cc8b0D624C"
BSC_RPC_URL = "https://bsc-dataseed.binance.org"

ELIGIBLE_PROCESSORS = (
    {
        "name": "Behemoth",
        "address": "0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C",
        "coefficient": 6,
    },
    {
        "name": "TapeOut",
        "address": "0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C",
        "coefficient": 1,
    },
)

TASK_FIELDS = (
    "id",
    "name",
    "tier",
    "group",
    "kind",
    "nIn",
    "nOut",
    "cycles",
    "g",
    "d",
    "K",
    "C",
)

ASSET_PATTERN = re.compile(r"(?:^|[\"'])/?(assets/[A-Za-z0-9_.-]+\.js)(?=[\"'])")
ADDRESS_PATTERN = re.compile(r"0x[a-fA-F0-9]{40}")
RPC_QUANTITY_PATTERN = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)")
RPC_BYTES_PATTERN = re.compile(r"0x(?:[0-9a-fA-F]{2})*")
WRITE_ABI_PATTERN = re.compile(
    r"function\s+(commitDesign|claim[A-Za-z0-9_]*|register[A-Za-z0-9_]*|mine[A-Za-z0-9_]*)\s*\(",
    re.IGNORECASE,
)
POD_MARKERS = (
    "proof of design",
    "commitdesign",
    "verifiedpool",
    "unverifiedpool",
    "registerminer",
    "claimtask",
    "claimreward",
)
MAX_CANDIDATE_ADDRESS_SAMPLE = 32


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class PublicDataError(RuntimeError):
    pass


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Request | None:
        del req, fp, code, msg, headers
        raise PublicDataError(f"refusing HTTP redirect to {newurl}")


class PublicHttpClient:
    def __init__(self, timeout_seconds: float = 8.0):
        self.timeout_seconds = timeout_seconds
        self.ssl_context = ssl.create_default_context()
        self.opener = build_opener(
            HTTPSHandler(context=self.ssl_context),
            _NoRedirectHandler(),
        )

    @staticmethod
    def _check_url(url: str, allowed_hosts: Iterable[str]) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in set(allowed_hosts):
            raise PublicDataError(f"refusing non-allowlisted URL: {url}")

    def get_bytes(
        self,
        url: str,
        *,
        max_bytes: int,
        allowed_hosts: Iterable[str] = ("tapeout.net",),
    ) -> bytes:
        self._check_url(url, allowed_hosts)
        request = Request(
            url,
            headers={
                "Accept": "application/json,text/html,application/javascript,*/*;q=0.5",
                "User-Agent": "mini4-pod-shadow-miner/0.1 (+https://github.com/tomandpeter/mini-4)",
            },
        )
        try:
            with self.opener.open(
                request,
                timeout=self.timeout_seconds,
            ) as response:
                self._check_url(response.geturl(), allowed_hosts)
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > max_bytes:
                    raise PublicDataError(f"response too large for {url}")
                body = response.read(max_bytes + 1)
        except PublicDataError:
            raise
        except Exception as exc:
            raise PublicDataError(f"GET failed for {url}: {type(exc).__name__}") from exc
        if len(body) > max_bytes:
            raise PublicDataError(f"response exceeded {max_bytes} bytes for {url}")
        return body

    def get_json(self, url: str, *, max_bytes: int = 2_000_000) -> Any:
        body = self.get_bytes(url, max_bytes=max_bytes)
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PublicDataError(f"invalid JSON from {url}") from exc

    def post_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        allowed_hosts: Iterable[str],
        max_bytes: int = 1_000_000,
    ) -> Any:
        self._check_url(url, allowed_hosts)
        request = Request(
            url,
            data=json.dumps(payload, separators=(",", ":")).encode(),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "mini4-pod-shadow-miner/0.1",
            },
            method="POST",
        )
        try:
            with self.opener.open(
                request,
                timeout=self.timeout_seconds,
            ) as response:
                self._check_url(response.geturl(), allowed_hosts)
                body = response.read(max_bytes + 1)
        except Exception as exc:
            raise PublicDataError(f"POST failed for {url}: {type(exc).__name__}") from exc
        if len(body) > max_bytes:
            raise PublicDataError(f"response exceeded {max_bytes} bytes for {url}")
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PublicDataError(f"invalid JSON-RPC response from {url}") from exc


def _positive_int(task: dict[str, Any], field: str, *, allow_zero: bool = False) -> int:
    value = task.get(field)
    minimum = 0 if allow_zero else 1
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise PublicDataError(f"task {task.get('id', '?')} has invalid {field}")
    return value


def validate_tasks_document(document: Any) -> list[dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("tasks"), list):
        raise PublicDataError("tasks document must contain a tasks array")
    tasks: list[dict[str, Any]] = []
    seen: set[int] = set()
    for raw in document["tasks"]:
        if not isinstance(raw, dict) or any(field not in raw for field in TASK_FIELDS):
            raise PublicDataError("task entry is missing required fields")
        task_id = _positive_int(raw, "id")
        if task_id in seen:
            raise PublicDataError(f"duplicate task id {task_id}")
        seen.add(task_id)
        if raw["kind"] not in ("comb", "seq"):
            raise PublicDataError(f"task {task_id} has invalid kind")
        if not all(isinstance(raw[field], str) and raw[field] for field in ("name", "tier", "group")):
            raise PublicDataError(f"task {task_id} has invalid text metadata")
        # Self-running sequential tasks legitimately publish zero input pins.
        _positive_int(raw, "nIn", allow_zero=True)
        for field in ("nOut", "g", "d", "K", "C"):
            _positive_int(raw, field)
        _positive_int(raw, "cycles")
        tasks.append({field: raw[field] for field in TASK_FIELDS})
    declared_total = document.get("total")
    if isinstance(declared_total, bool) or declared_total != len(tasks):
        raise PublicDataError("declared task total does not match task array")
    return sorted(tasks, key=lambda task: task["id"])


def fetch_tasks(client: PublicHttpClient) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    document = client.get_json(TASKS_URL)
    tasks = validate_tasks_document(document)
    canonical = json.dumps(tasks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    kinds: dict[str, int] = {"comb": 0, "seq": 0}
    tiers: dict[str, int] = {}
    for task in tasks:
        kinds[task["kind"]] += 1
        tiers[task["tier"]] = tiers.get(task["tier"], 0) + 1
    summary = {
        "source": TASKS_URL,
        "count": len(tasks),
        "sha256": hashlib.sha256(canonical).hexdigest(),
        "kinds": kinds,
        "tiers": dict(sorted(tiers.items())),
        "published_fields": list(TASK_FIELDS),
        "verification_vectors_published": False,
    }
    return tasks, summary


def fetch_circuit_market_summary(client: PublicHttpClient) -> dict[str, Any]:
    document = client.get_json(CIRCUIT_MARKET_URL, max_bytes=12_000_000)
    if not isinstance(document, dict) or not isinstance(document.get("listings"), list):
        raise PublicDataError("circuit market document must contain a listings array")
    block = document.get("block")
    generated_at = document.get("generatedAt")
    market_address = document.get("marketAddr")
    if isinstance(block, bool) or not isinstance(block, int) or block <= 0:
        raise PublicDataError("circuit market block is invalid")
    if not isinstance(generated_at, str) or not generated_at:
        raise PublicDataError("circuit market generatedAt is invalid")
    if not isinstance(market_address, str) or not ADDRESS_PATTERN.fullmatch(market_address):
        raise PublicDataError("circuit market address is invalid")

    valid = 0
    eligible = 0
    eligible_with_refs = 0
    processors: dict[str, int] = {}
    digest_rows: list[tuple[Any, ...]] = []
    for listing in document["listings"]:
        if not isinstance(listing, dict):
            raise PublicDataError("circuit market listing is not an object")
        is_valid = listing.get("valid") is True
        is_eligible = listing.get("eligible") is True
        refs = listing.get("refs", 0)
        if isinstance(refs, bool) or not isinstance(refs, int) or refs < 0:
            raise PublicDataError("circuit market listing has invalid refs")
        processor = str(listing.get("procName") or "unknown")
        valid += int(is_valid)
        eligible += int(is_eligible)
        eligible_with_refs += int(is_eligible and refs > 0)
        if is_eligible:
            processors[processor] = processors.get(processor, 0) + 1
        digest_rows.append(
            (
                listing.get("id"),
                listing.get("circuits"),
                listing.get("circuitId"),
                is_valid,
                is_eligible,
                refs,
                listing.get("ownGates"),
            )
        )
    canonical = json.dumps(digest_rows, sort_keys=True, separators=(",", ":")).encode()
    return {
        "source": CIRCUIT_MARKET_URL,
        "generated_at": generated_at,
        "block": block,
        "market_address": market_address,
        "max_id": document.get("maxId"),
        "listing_count": len(document["listings"]),
        "valid_listing_count": valid,
        "frontend_eligible_count": eligible,
        "frontend_eligible_with_refs": eligible_with_refs,
        "eligible_processors": dict(sorted(processors.items())),
        "sha256": hashlib.sha256(canonical).hexdigest(),
        "warning": (
            "frontend eligible is observational only; public formula says any REF is ineligible"
        ),
    }


def extract_asset_paths(text: str) -> set[str]:
    return {match.group(1) for match in ASSET_PATTERN.finditer(text)}


@dataclass(frozen=True)
class FrontendScan:
    asset_count: int
    bytes_scanned: int
    marker_assets: tuple[str, ...]
    markers: tuple[str, ...]
    write_abi_functions: tuple[str, ...]
    candidate_address_occurrences: int
    candidate_addresses: tuple[str, ...]
    errors: tuple[str, ...]
    fingerprint: str

    @property
    def reward_contract_status(self) -> str:
        if self.write_abi_functions and self.candidate_address_occurrences:
            return "candidate_requires_manual_verification"
        return "not_published_in_scanned_assets"

    def as_dict(self) -> dict[str, Any]:
        return {
            "asset_count": self.asset_count,
            "bytes_scanned": self.bytes_scanned,
            "marker_assets": list(self.marker_assets),
            "markers": list(self.markers),
            "write_abi_functions": list(self.write_abi_functions),
            "candidate_address_occurrences": self.candidate_address_occurrences,
            "candidate_addresses": list(self.candidate_addresses),
            "reward_contract_status": self.reward_contract_status,
            "errors": list(self.errors),
            "fingerprint": self.fingerprint,
        }


def scan_public_frontend(
    client: PublicHttpClient,
    *,
    max_assets: int = 20,
    max_asset_bytes: int = 2_000_000,
    max_total_bytes: int = 10_000_000,
) -> FrontendScan:
    """Scan bounded public JS assets for PoD publication signals.

    This is deliberately discovery-only.  An address found here is never
    trusted as a transaction target.
    """

    errors: list[str] = []
    texts: dict[str, str] = {}
    try:
        home_bytes = client.get_bytes(TAPEOUT_HOME_URL, max_bytes=1_000_000)
        home = home_bytes.decode("utf-8", "replace")
    except PublicDataError as exc:
        raise PublicDataError(f"frontend root unavailable: {exc}") from exc

    def priority(path: str) -> tuple[int, str]:
        lowered = path.lower()
        keywords = ("formula", "task", "app-", "landing", "chain-", "circuitmarket")
        return (0 if any(keyword in lowered for keyword in keywords) else 1, path)

    pending = sorted(extract_asset_paths(home), key=priority)
    seen: set[str] = set()
    total_bytes = len(home_bytes)
    while pending and len(seen) < max_assets and total_bytes < max_total_bytes:
        path = pending.pop(0)
        if path in seen:
            continue
        seen.add(path)
        url = urljoin(TAPEOUT_HOME_URL, path)
        try:
            body = client.get_bytes(url, max_bytes=max_asset_bytes)
        except PublicDataError as exc:
            errors.append(f"{path}:{exc}")
            continue
        total_bytes += len(body)
        text = body.decode("utf-8", "replace")
        texts[path] = text
        for discovered in sorted(extract_asset_paths(text), key=priority):
            if discovered not in seen and discovered not in pending:
                pending.append(discovered)
        pending.sort(key=priority)

    marker_assets: set[str] = set()
    markers: set[str] = set()
    write_functions: set[str] = set()
    addresses: set[str] = set()
    address_occurrences = 0
    known_processors = {
        MINI4_PROCESSOR.lower(),
        *(item["address"].lower() for item in ELIGIBLE_PROCESSORS),
    }
    for path, text in texts.items():
        lowered = text.lower()
        found_markers = {marker for marker in POD_MARKERS if marker in lowered}
        found_functions = {match.group(1) for match in WRITE_ABI_PATTERN.finditer(text)}
        if not found_markers and not found_functions:
            continue
        marker_assets.add(path)
        markers.update(found_markers)
        write_functions.update(found_functions)
        for match in ADDRESS_PATTERN.finditer(text):
            address = match.group(0)
            if address.lower() in known_processors:
                continue
            address_occurrences += 1
            if len(addresses) < MAX_CANDIDATE_ADDRESS_SAMPLE:
                addresses.add(address)

    digest = hashlib.sha256()
    digest.update(home_bytes)
    for path in sorted(texts):
        digest.update(path.encode())
        digest.update(hashlib.sha256(texts[path].encode()).digest())
    return FrontendScan(
        asset_count=len(texts),
        bytes_scanned=total_bytes,
        marker_assets=tuple(sorted(marker_assets)),
        markers=tuple(sorted(markers)),
        write_abi_functions=tuple(sorted(write_functions)),
        candidate_address_occurrences=address_occurrences,
        candidate_addresses=tuple(sorted(addresses, key=str.lower)),
        errors=tuple(errors[:20]),
        fingerprint=digest.hexdigest(),
    )


def read_mini4_chain(client: PublicHttpClient) -> dict[str, Any]:
    host = urlparse(BSC_RPC_URL).hostname
    if not host:
        raise PublicDataError("BSC RPC URL has no host")

    def rpc(method: str, params: list[Any], request_id: int) -> Any:
        response = client.post_json(
            BSC_RPC_URL,
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            allowed_hosts=(host,),
        )
        if (
            not isinstance(response, dict)
            or response.get("jsonrpc") != "2.0"
            or response.get("id") != request_id
            or "result" not in response
        ):
            raise PublicDataError(f"invalid JSON-RPC result for {method}")
        return response["result"]

    chain_id_hex = rpc("eth_chainId", [], 1)
    block_hex = rpc("eth_blockNumber", [], 2)
    code = rpc("eth_getCode", [MINI4_PROCESSOR, "latest"], 3)
    if (
        not isinstance(chain_id_hex, str)
        or not RPC_QUANTITY_PATTERN.fullmatch(chain_id_hex)
        or not isinstance(block_hex, str)
        or not RPC_QUANTITY_PATTERN.fullmatch(block_hex)
        or not isinstance(code, str)
        or not RPC_BYTES_PATTERN.fullmatch(code)
    ):
        raise PublicDataError("malformed BSC JSON-RPC result")
    try:
        chain_id = int(chain_id_hex, 16)
        block_number = int(block_hex, 16)
        code_bytes = bytes.fromhex(code[2:])
    except (ValueError, OverflowError) as exc:
        raise PublicDataError("malformed BSC JSON-RPC hexadecimal data") from exc
    if chain_id <= 0 or block_number <= 0:
        raise PublicDataError("BSC JSON-RPC returned a non-positive chain or block number")
    return {
        "rpc": BSC_RPC_URL,
        "chain_id": chain_id,
        "block_number": block_number,
        "processor": MINI4_PROCESSOR,
        "code_present": bool(code_bytes),
        "code_sha256": hashlib.sha256(code_bytes).hexdigest() if code_bytes else None,
    }
