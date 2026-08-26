"""Bounded JSONL log-tail reader used by the headless status API."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_TAIL_MAX_BYTES = 2 * 1024 * 1024


def tail_jsonl(path: Path, *, limit: int) -> list[dict[str, Any]]:
    """Return up to ``limit`` JSON log records from the tail of ``path``."""
    if limit <= 0 or not path.exists():
        return []

    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size == 0:
        return []

    read_size = min(size, _TAIL_MAX_BYTES)
    with path.open("rb") as fh:
        fh.seek(size - read_size)
        chunk = fh.read(read_size)

    if read_size < size:
        newline = chunk.find(b"\n")
        if newline == -1:
            return []
        chunk = chunk[newline + 1 :]

    out: list[dict[str, Any]] = []
    for raw in chunk.splitlines()[-limit:]:
        line = raw.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                out.append(value)
                continue
        except json.JSONDecodeError:
            pass
        out.append({"level": "RAW", "logger": "raw", "msg": line.decode("utf-8", errors="replace")})
    return out


__all__ = ["tail_jsonl"]
