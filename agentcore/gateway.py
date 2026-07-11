"""Local stand-in for Amazon Bedrock AgentCore Gateway.

AgentCore Gateway turns existing APIs into MCP tools agents can call.
This does the same offline: a streamable-HTTP MCP server that exposes
Instanote's typed JSON-RPC API (the AWS Blocks dev server on :3000) as
five MCP tools. The agent runtime connects to it exactly the way it
would connect to a real Gateway endpoint — only the URL changes.

Auth: signs in to Instanote with AGENTCORE_USER / AGENTCORE_PASSWORD
(creating the account on first run) and keeps the session cookie. Real
AgentCore replaces this with Identity-managed credentials.

Run:  .venv/bin/python gateway.py          (listens on 127.0.0.1:8933)
"""
from __future__ import annotations

import itertools
import os

import httpx
from mcp.server.fastmcp import FastMCP

API = os.environ.get("INSTANOTE_API", "http://localhost:3000/aws-blocks/api")
USER = os.environ.get("AGENTCORE_USER", "agentcore@example.com")
PASSWORD = os.environ.get("AGENTCORE_PASSWORD", "AgentCore123!")

_ids = itertools.count(1)
_client = httpx.Client(timeout=15)  # cookie jar persists the session


def rpc(method: str, params: list):
    r = _client.post(API, json={
        "jsonrpc": "2.0", "method": method, "params": params, "id": next(_ids),
    })
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method}: {body['error'].get('message', body['error'])}")
    return body.get("result")


def ensure_session() -> None:
    state = rpc("authApi.getAuthState", [])
    if state.get("state") == "signedIn":
        return
    result = rpc("authApi.setAuthState", [
        {"action": "signIn", "username": USER, "password": PASSWORD}])
    if result.get("state") != "signedIn":
        result = rpc("authApi.setAuthState", [
            {"action": "signUp", "username": USER, "password": PASSWORD}])
    if result.get("state") != "signedIn":
        raise RuntimeError(f"Could not establish Instanote session: {result.get('error')}")


mcp = FastMCP("instanote-gateway", host="127.0.0.1", port=8933)


# Small local models pass sloppy tool arguments (tags as "", null strings,
# or even the JSON schema itself as the value). Coerce instead of reject.
def _as_text(value) -> str:
    if isinstance(value, dict):
        for key in ("description", "value", "query", "title"):
            if isinstance(value.get(key), str):
                return value[key]
        return ""
    return str(value or "")


def _as_tags(value) -> list[str]:
    if isinstance(value, list):
        return [str(t) for t in value if str(t).strip()]
    return [t.strip() for t in _as_text(value).split(",") if t.strip()]


@mcp.tool()
def search_notes(query) -> list[dict]:
    """Search the user's notes by keyword. Pass query as a plain string."""
    ensure_session()
    q = _as_text(query).lower()
    notes = rpc("api.listNotes", [])
    return [
        {"noteId": n["noteId"], "title": n["title"], "body": n["body"],
         "tags": n["tags"], "dueDate": n["dueDate"], "completed": n["completed"]}
        for n in notes
        if q in n["title"].lower() or q in n["body"].lower()
        or any(q in t.lower() for t in n["tags"])
    ][:10]


@mcp.tool()
def list_due_soon() -> list[dict]:
    """List incomplete notes due within 7 days, including overdue ones."""
    ensure_session()
    import time
    horizon = (time.time() + 7 * 86400) * 1000
    notes = rpc("api.listNotes", ["dueDate"])
    return [
        {"noteId": n["noteId"], "title": n["title"], "dueDate": n["dueDate"]}
        for n in notes
        if not n["completed"] and 0 < n["dueDate"] <= horizon
    ]


@mcp.tool()
def add_note(title, body="", tags=None, due_date_iso=None) -> dict:
    """Create a new note. Pass title/body as strings, tags as a list of
    strings, due_date_iso as ISO 8601 (e.g. 2026-07-10) or omit it."""
    ensure_session()
    due_ms = 0
    due_text = _as_text(due_date_iso)
    if due_text and due_text.lower() not in ("null", "none"):
        from datetime import datetime
        due_ms = int(datetime.fromisoformat(due_text).timestamp() * 1000)
    note = rpc("api.createNote", [_as_text(title), _as_text(body), _as_tags(tags), due_ms])
    return {"created": True, "noteId": note["noteId"], "title": note["title"]}


@mcp.tool()
def complete_note(note_id) -> dict:
    """Mark a note as completed by its noteId."""
    ensure_session()
    note = rpc("api.getNote", [_as_text(note_id)])
    if not note["completed"]:
        rpc("api.toggleNote", [note_id])
    return {"completed": True, "title": note["title"]}


@mcp.tool()
def search_help(query) -> list[dict]:
    """Search Instanote's help documentation. Pass query as a plain string."""
    ensure_session()
    results = rpc("api.searchHelp", [_as_text(query)])
    return [{"text": r["text"], "source": r["source"]} for r in results[:3]]


if __name__ == "__main__":
    ensure_session()
    print(f"[gateway] session ready for {USER}; MCP on http://127.0.0.1:8933/mcp")
    mcp.run(transport="streamable-http")
