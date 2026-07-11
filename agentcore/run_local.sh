#!/usr/bin/env bash
# Start the full offline AgentCore stack. Prereqs: `ollama serve` and the
# Instanote dev server (`npm run dev`) already running.
set -euo pipefail
cd "$(dirname "$0")"

MODEL=${INSTANOTE_OLLAMA_MODEL:-llama3.2:3b}

curl -sf http://localhost:11434/api/tags >/dev/null || { echo "ollama not running — start with: ollama serve"; exit 1; }
ollama list | grep -q "${MODEL%%:*}" || { echo "model $MODEL not pulled — run: ollama pull $MODEL"; exit 1; }
curl -sf http://localhost:3000/ >/dev/null || { echo "Instanote dev server not running — start with: npm run dev"; exit 1; }

echo "starting gateway (MCP, :8933)..."
.venv/bin/python gateway.py &
GATEWAY_PID=$!
trap 'kill $GATEWAY_PID 2>/dev/null' EXIT
sleep 2

echo "starting agent (AgentCore runtime contract, :8080)..."
exec .venv/bin/python agent.py
