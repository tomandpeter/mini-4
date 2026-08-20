"""Small SQLite history store and atomic latest-state writer."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any


SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    task_count INTEGER,
    healthy INTEGER NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_observed_at_idx
    ON snapshots(observed_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_fingerprint_idx
    ON snapshots(fingerprint);
"""


class StateStore:
    def __init__(self, data_dir: str | Path, *, retention: int = 2_000):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.data_dir / "history.sqlite3"
        self.latest_path = self.data_dir / "latest.json"
        self.retention = retention
        with self._connect() as connection:
            connection.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    def load_latest(self) -> dict[str, Any] | None:
        try:
            value = json.loads(self.latest_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def save(self, payload: dict[str, Any]) -> bool:
        serialized = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        previous = self.load_latest()
        changed = not previous or previous.get("fingerprint") != payload.get("fingerprint")
        self._atomic_write(serialized + "\n")
        if changed:
            task_summary = payload.get("tasks")
            task_count = (
                task_summary.get("count")
                if isinstance(task_summary, dict)
                else None
            )
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO snapshots (
                        observed_at, fingerprint, task_count, healthy, payload_json
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        payload.get("observed_at"),
                        payload.get("fingerprint", ""),
                        task_count,
                        int(bool(payload.get("healthy"))),
                        serialized,
                    ),
                )
                connection.execute(
                    """
                    DELETE FROM snapshots
                    WHERE id NOT IN (
                        SELECT id FROM snapshots ORDER BY id DESC LIMIT ?
                    )
                    """,
                    (self.retention,),
                )
        return changed

    def history_summary(self) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*), MIN(observed_at), MAX(observed_at)
                FROM snapshots
                """
            ).fetchone()
        return {
            "snapshots": int(row[0] or 0),
            "first_observed_at": row[1],
            "last_observed_at": row[2],
        }

    def _atomic_write(self, content: str) -> None:
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix="latest.", suffix=".tmp", dir=self.data_dir
        )
        try:
            with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, self.latest_path)
        except Exception:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise
