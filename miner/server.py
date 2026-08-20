"""Local HTTP status surface for the shadow miner."""

from __future__ import annotations

import html
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .watcher import ShadowMiner


def _dashboard(status: dict[str, object]) -> bytes:
    tasks = status.get("tasks") or {}
    protocol = status.get("protocol") or {}
    mini4 = status.get("mini4") or {}
    errors = status.get("errors") or {}
    task_count = tasks.get("count", "—") if isinstance(tasks, dict) else "—"
    reward_ready = protocol.get("reward_contract_ready", False) if isinstance(protocol, dict) else False
    eligible = mini4.get("eligible_by_current_public_rules", False) if isinstance(mini4, dict) else False
    body = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>MINI-4 PoD Shadow Miner</title>
<style>
body{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#080b10;color:#e8f0ff;margin:0;padding:32px}}
main{{max-width:880px;margin:auto}} .card{{border:1px solid #263246;background:#0e141e;padding:20px;margin:14px 0;border-radius:12px}}
.ok{{color:#73e6a6}} .warn{{color:#ffd166}} code{{color:#9cc7ff}} a{{color:#9cc7ff}}
</style></head><body><main>
<h1>MINI-4 PoD Shadow Miner</h1>
<p class="warn">READ-ONLY · NO WALLET · NO TRANSACTIONS</p>
<div class="card"><div>Status: <strong>{html.escape(str(status.get('status', 'unknown')))}</strong></div>
<div>Observed: {html.escape(str(status.get('observed_at') or '—'))}</div>
<div>Official tasks: {html.escape(str(task_count))}</div></div>
<div class="card"><div>PoD reward contract ready: <strong>{str(bool(reward_ready)).lower()}</strong></div>
<div>MINI-4 currently eligible: <strong>{str(bool(eligible)).lower()}</strong></div>
<div>Errors: {html.escape(', '.join(errors) if isinstance(errors, dict) and errors else 'none')}</div></div>
<p><a href="/api/status">/api/status</a> · <a href="/api/tasks?limit=20">/api/tasks</a> · <a href="/healthz">/healthz</a> · <a href="/metrics">/metrics</a></p>
</main></body></html>"""
    return body.encode()


def make_handler(miner: ShadowMiner) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "Mini4ShadowMiner/0.1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _send(self, status_code: int, content_type: str, body: bytes) -> None:
            self.send_response(status_code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status_code: int, value: object) -> None:
            self._send(
                status_code,
                "application/json; charset=utf-8",
                (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode(),
            )

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            parsed = urlparse(self.path)
            status = miner.status()
            if parsed.path == "/":
                self._send(HTTPStatus.OK, "text/html; charset=utf-8", _dashboard(status))
                return
            if parsed.path == "/healthz":
                code = HTTPStatus.OK if status.get("healthy") else HTTPStatus.SERVICE_UNAVAILABLE
                self._json(code, {"healthy": bool(status.get("healthy")), "status": status.get("status")})
                return
            if parsed.path == "/api/status":
                self._json(HTTPStatus.OK, status)
                return
            if parsed.path == "/api/tasks":
                query = parse_qs(parsed.query)
                try:
                    limit = int(query.get("limit", ["100"])[0])
                except ValueError:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "limit must be an integer"})
                    return
                limit = max(1, min(limit, 500))
                tasks = miner.tasks()
                self._json(HTTPStatus.OK, {"count": len(tasks), "returned": min(limit, len(tasks)), "tasks": tasks[:limit]})
                return
            if parsed.path == "/metrics":
                task_count = ((status.get("tasks") or {}).get("count", 0) if isinstance(status.get("tasks"), dict) else 0)
                errors = status.get("errors") or {}
                metrics = (
                    f"mini4_shadow_healthy {1 if status.get('healthy') else 0}\n"
                    f"mini4_shadow_tasks {int(task_count or 0)}\n"
                    f"mini4_shadow_errors {len(errors) if isinstance(errors, dict) else 0}\n"
                    "mini4_shadow_transactions_enabled 0\n"
                ).encode()
                self._send(HTTPStatus.OK, "text/plain; version=0.0.4; charset=utf-8", metrics)
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    return Handler


def make_server(miner: ShadowMiner, bind: str, port: int) -> ThreadingHTTPServer:
    if not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    return ThreadingHTTPServer((bind, port), make_handler(miner))
