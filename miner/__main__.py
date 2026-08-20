"""Command-line entry point for ``python3 -m miner``."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import threading
from pathlib import Path

from .formula import score_candidate
from .search import BUILTIN_TARGETS, search_nand_network
from .server import make_server
from .storage import StateStore
from .watcher import ShadowMiner


PROCESSOR_COEFFICIENTS = {"tapeout": 1.0, "behemoth": 6.0}


def _common_watcher_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--data-dir", default="miner/state")
    parser.add_argument("--poll-seconds", type=int, default=300)
    parser.add_argument("--protocol-scan-seconds", type=int, default=21_600)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MINI-4 read-only PoD shadow miner")
    parser.add_argument("--log-level", default="INFO", choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run watcher and local status server")
    _common_watcher_arguments(run_parser)
    run_parser.add_argument("--bind", default="127.0.0.1")
    run_parser.add_argument("--port", type=int, default=8787)

    once_parser = subparsers.add_parser("once", help="perform one public-source scan")
    _common_watcher_arguments(once_parser)
    once_parser.add_argument("--skip-protocol-scan", action="store_true")

    score_parser = subparsers.add_parser("score", help="score candidate metadata")
    score_parser.add_argument("--local-nand", type=int, required=True)
    score_parser.add_argument("--local-latch", type=int, default=0)
    score_parser.add_argument("--recursive-elements", type=int, required=True)
    score_parser.add_argument("--recursive-latches", type=int, default=0)
    score_parser.add_argument("--depth", type=int, required=True)
    score_parser.add_argument("--task-k", type=float, required=True)
    score_parser.add_argument("--reference-cost", type=float, required=True)
    score_parser.add_argument("--processor", choices=tuple(PROCESSOR_COEFFICIENTS), required=True)

    search_parser = subparsers.add_parser("search", help="bounded flat-NAND truth-table search")
    search_parser.add_argument("--profile", choices=tuple(BUILTIN_TARGETS))
    search_parser.add_argument("--inputs", type=int)
    search_parser.add_argument("--targets", help="comma-separated packed tables, for example 0x6,0x8")
    search_parser.add_argument("--max-gates", type=int, default=5)
    search_parser.add_argument("--max-states", type=int, default=250_000)
    search_parser.add_argument("--time-limit-seconds", type=float, default=5.0)
    return parser


def _make_miner(args: argparse.Namespace) -> ShadowMiner:
    store = StateStore(Path(args.data_dir))
    return ShadowMiner(
        store=store,
        poll_seconds=args.poll_seconds,
        protocol_scan_seconds=args.protocol_scan_seconds,
    )


def command_run(args: argparse.Namespace) -> int:
    miner = _make_miner(args)
    server = make_server(miner, args.bind, args.port)
    server_thread = threading.Thread(target=server.serve_forever, name="status-http", daemon=True)
    server_thread.start()

    def stop(_signum: int, _frame: object) -> None:
        miner.stop()
        server.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.getLogger("mini4_miner").info(
        "SHADOW_START bind=%s port=%s transactions_enabled=false", args.bind, args.port
    )
    try:
        miner.run_forever()
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)
    return 0


def command_once(args: argparse.Namespace) -> int:
    miner = _make_miner(args)
    status = miner.poll_once(
        force_protocol_scan=not args.skip_protocol_scan,
        skip_protocol_scan=args.skip_protocol_scan,
    )
    print(json.dumps(status, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if status.get("healthy") else 1


def command_score(args: argparse.Namespace) -> int:
    score = score_candidate(
        local_nand=args.local_nand,
        local_latch=args.local_latch,
        recursive_elements=args.recursive_elements,
        recursive_latches=args.recursive_latches,
        depth=args.depth,
        task_k=args.task_k,
        reference_cost=args.reference_cost,
        processor_coefficient=PROCESSOR_COEFFICIENTS[args.processor],
    )
    print(json.dumps(score.as_dict(), sort_keys=True, indent=2))
    return 0


def command_search(args: argparse.Namespace) -> int:
    if args.profile:
        n_inputs, targets = BUILTIN_TARGETS[args.profile]
    else:
        if args.inputs is None or not args.targets:
            raise SystemExit("search requires --profile or both --inputs and --targets")
        n_inputs = args.inputs
        try:
            targets = tuple(int(value.strip(), 0) for value in args.targets.split(","))
        except ValueError as exc:
            raise SystemExit("--targets must be comma-separated integers") from exc
    result = search_nand_network(
        n_inputs=n_inputs,
        target_tables=targets,
        max_gates=args.max_gates,
        max_states=args.max_states,
        time_limit_seconds=args.time_limit_seconds,
    )
    print(json.dumps(result.as_dict(), sort_keys=True, indent=2))
    return 0 if result.netlist else 2


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    commands = {
        "run": command_run,
        "once": command_once,
        "score": command_score,
        "search": command_search,
    }
    return commands[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
