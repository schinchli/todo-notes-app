"""Instanote agent on the Amazon Bedrock AgentCore Runtime contract — fully offline.

Every AgentCore component runs locally:

  Runtime       BedrockAgentCoreApp serves the real AgentCore HTTP contract
                (POST /invocations, GET /ping) on :8080 — the same code
                `agentcore deploy` ships to the managed runtime.
  Model         Strands Agent + Ollama (llama3.2:3b by default) — local
                inference, no Bedrock, no internet.
  Gateway       MCP tools served by gateway.py (Instanote's API as tools),
                consumed over streamable HTTP like a real Gateway endpoint.
  Memory        memory.py — short-term events + long-term facts on disk.
  Identity      offline stub: actor_id from the request payload (real
                AgentCore derives it from Identity/OAuth).
  Observability OpenTelemetry span per invocation, console exporter.

Moving to AWS later = swap OllamaModel for a Bedrock model id, point the
MCP client at a Gateway URL, and replace MemoryStore with the AgentCore
Memory client. The entrypoint below is unchanged.

Run:  .venv/bin/python agent.py     (needs ollama + gateway.py running)
Test: curl -X POST localhost:8080/invocations -d '{"prompt": "what is due soon?"}'
"""
from __future__ import annotations

import os
import time

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp.client.streamable_http import streamablehttp_client
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from strands import Agent
from strands.models.ollama import OllamaModel
from strands.tools.mcp import MCPClient

from memory import MemoryStore

OLLAMA_HOST = os.environ.get("INSTANOTE_OLLAMA_HOST", "http://localhost:11434")
MODEL_ID = os.environ.get("INSTANOTE_OLLAMA_MODEL", "llama3.2:3b")
GATEWAY_URL = os.environ.get("AGENTCORE_GATEWAY_URL", "http://127.0.0.1:8933/mcp")

SYSTEM_PROMPT = (
    "You are the Instanote assistant. Use the tools to search notes, list due "
    "items, add notes, complete notes, and search help. Answer briefly. "
    "When the user asks you to remember something about themselves, restate "
    "the fact in one short sentence prefixed exactly with 'REMEMBER: '."
)

# ── Observability: one span per invocation, printed to the console ──────────
provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("instanote-agentcore")

# ── Gateway tools (kept open for the process lifetime) ──────────────────────
gateway = MCPClient(lambda: streamablehttp_client(GATEWAY_URL))
gateway.__enter__()
TOOLS = gateway.list_tools_sync()
print(f"[agent] gateway tools: {[t.tool_name for t in TOOLS]}")

model = OllamaModel(host=OLLAMA_HOST, model_id=MODEL_ID)
memory = MemoryStore()
app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload: dict, context=None) -> dict:
    prompt = payload.get("prompt", "")
    actor_id = payload.get("actor_id", "local-user")       # Identity stub
    session_id = payload.get("session_id", "default")
    if not prompt:
        return {"error": "payload must include 'prompt'"}

    with tracer.start_as_current_span("invocation") as span:
        span.set_attribute("agent.actor_id", actor_id)
        span.set_attribute("agent.session_id", session_id)
        span.set_attribute("agent.model", MODEL_ID)
        started = time.time()

        # Memory → context: long-term facts + this session's recent turns.
        facts = memory.recall_facts(actor_id)
        history = memory.recent_events(actor_id, session_id, k=8)
        context_lines = []
        if facts:
            context_lines.append("Known facts about this user: " + "; ".join(facts))
        for event in history:
            context_lines.append(f"{event['role']}: {event['text']}")
        system = SYSTEM_PROMPT
        if context_lines:
            system += "\n\nConversation context:\n" + "\n".join(context_lines)

        agent = Agent(model=model, tools=TOOLS, system_prompt=system)
        result = agent(prompt)
        text = str(result).strip()

        # Persist short-term turns; promote REMEMBER lines to long-term facts.
        memory.create_event(actor_id, session_id, "user", prompt)
        memory.create_event(actor_id, session_id, "assistant", text)
        for line in text.splitlines():
            if line.strip().startswith("REMEMBER:"):
                memory.remember_fact(actor_id, line.split("REMEMBER:", 1)[1].strip())

        span.set_attribute("agent.latency_ms", int((time.time() - started) * 1000))
        return {
            "result": text,
            "model": MODEL_ID,
            "actor_id": actor_id,
            "session_id": session_id,
        }


if __name__ == "__main__":
    port = int(os.environ.get("AGENTCORE_PORT", "8080"))
    print(f"[agent] AgentCore runtime on :{port} · model {MODEL_ID} via {OLLAMA_HOST}")
    app.run(port=port)
