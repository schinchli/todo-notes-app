"""End-to-end offline smoke test for the AgentCore stack.

Requires: ollama serve, npm run dev (Instanote), gateway.py, agent.py.
Verifies the full loop: Runtime contract -> Strands+Ollama -> Gateway MCP
tool -> Instanote API -> DynamoDB-mock, plus Memory across sessions.

Run:  .venv/bin/python smoke.py
"""
from __future__ import annotations

import sys
import time
import uuid

import httpx

import os
RUNTIME = f"http://localhost:{os.environ.get('AGENTCORE_PORT', '8080')}"
MARKER = f"smoke-{uuid.uuid4().hex[:6]}"
ACTOR = f"smoke-actor-{MARKER}"
client = httpx.Client(timeout=180)

checks: list[tuple[str, bool, str]] = []


def invoke(prompt: str, session: str) -> str:
    r = client.post(f"{RUNTIME}/invocations", json={
        "prompt": prompt, "actor_id": ACTOR, "session_id": session,
    })
    r.raise_for_status()
    body = r.json()
    if "error" in body and body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


# 1. Runtime contract: /ping
ping = client.get(f"{RUNTIME}/ping")
check("runtime /ping", ping.status_code == 200, f"status {ping.status_code}")

# 2. Plain chat through local model
reply = invoke("Reply with exactly the word: ready", "s1")
check("local model chat", len(reply) > 0, reply[:60])

# 3. Tool call through Gateway: create a note, verify DETERMINISTICALLY in
#    Instanote's store (model prose can hallucinate success).
import itertools
_ids = itertools.count(1)
api = httpx.Client(timeout=15)


def rpc(method: str, params: list):
    r = api.post("http://localhost:3000/aws-blocks/api", json={
        "jsonrpc": "2.0", "method": method, "params": params, "id": next(_ids)})
    body = r.json()
    if "error" in body:
        raise RuntimeError(body["error"])
    return body.get("result")


rpc("authApi.setAuthState", [{"action": "signIn",
    "username": "agentcore@example.com", "password": "AgentCore123!"}])

invoke(f"Add a note titled '{MARKER} groceries' about buying oat milk", "s1")
time.sleep(1)
stored = [n["title"] for n in rpc("api.listNotes", []) if MARKER in n["title"]]
check("gateway tool round-trip (note exists in store)", len(stored) == 1, str(stored))

# 4. Long-term memory: verify the fact is persisted on disk AND recalled in a
#    brand-new session.
invoke("Please remember that my favourite grocery store is BigBasket", "s1")
from pathlib import Path
import json as jsonlib
fact_files = list((Path(__file__).parent / ".memory" / "facts").glob(f"*{MARKER}*.json"))
facts = jsonlib.loads(fact_files[0].read_text()) if fact_files else []
check("memory fact persisted to disk", any("bigbasket" in f["fact"].lower() for f in facts),
      str([f["fact"] for f in facts])[:100])
recalled = invoke("What is my favourite grocery store? Answer from what you know about me.", "s2")
check("memory recall across sessions", "bigbasket" in recalled.lower(), recalled[:100])

failed = [c for c in checks if not c[1]]
print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
sys.exit(1 if failed else 0)
