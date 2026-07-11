"""Local stand-in for Amazon Bedrock AgentCore Memory.

Mirrors the two AgentCore Memory concepts offline:
  - short-term memory: raw conversation events per (actor, session)
  - long-term memory:  durable facts per actor, recalled across sessions

Backed by JSON files under .memory/ so everything survives restarts and
stays on the machine. On AWS this module is replaced by the AgentCore
Memory service (create_event / retrieve_memory_records) — the interface
below is intentionally shaped like that API.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).parent / ".memory"


def _store(path: Path) -> list:
    return json.loads(path.read_text()) if path.exists() else []


def _save(path: Path, items: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=1))


class MemoryStore:
    def __init__(self, root: Path = ROOT):
        self.root = root

    # ── short-term (events, session-scoped) ──────────────────────────────
    def _events_path(self, actor_id: str, session_id: str) -> Path:
        safe = re.sub(r"[^\w.-]", "_", f"{actor_id}__{session_id}")
        return self.root / "events" / f"{safe}.json"

    def create_event(self, actor_id: str, session_id: str, role: str, text: str) -> None:
        path = self._events_path(actor_id, session_id)
        events = _store(path)
        events.append({"role": role, "text": text, "ts": time.time()})
        _save(path, events)

    def recent_events(self, actor_id: str, session_id: str, k: int = 10) -> list[dict]:
        return _store(self._events_path(actor_id, session_id))[-k:]

    # ── long-term (facts, actor-scoped, cross-session) ───────────────────
    def _facts_path(self, actor_id: str) -> Path:
        safe = re.sub(r"[^\w.-]", "_", actor_id)
        return self.root / "facts" / f"{safe}.json"

    def remember_fact(self, actor_id: str, fact: str) -> None:
        path = self._facts_path(actor_id)
        facts = _store(path)
        if fact not in [f["fact"] for f in facts]:
            facts.append({"fact": fact, "ts": time.time()})
            _save(path, facts)

    def recall_facts(self, actor_id: str) -> list[str]:
        return [f["fact"] for f in _store(self._facts_path(actor_id))]
