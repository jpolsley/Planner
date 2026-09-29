#!/bin/bash
# Steward launcher for macOS (used by the Steward app): starts Ollama and the Steward server if they
# aren't running yet, then opens Steward in the browser. Server output goes to server.log next to this file.
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$DIR/server.log"
URL="${STEWARD_URL:-https://ministryai.github.io/Planner/}"
up() { curl -s -m 2 "$1" >/dev/null; }

# 1. Ollama (skipped when steward.env points the AI somewhere else). If one is already running, it is used as is.
if ! grep -qE '^LLM_URL=https?://' "$DIR/steward.env" 2>/dev/null || grep -q ':11434' "$DIR/steward.env"; then
  if ! up http://127.0.0.1:11434/api/tags; then
    # Start Ollama's server directly (not the app), so its model folder is the one we choose. The server
    # decides where models live; the default is on this computer. Override with STEWARD_OLLAMA_MODELS.
    OLLAMA_BIN=""
    for b in "$HOME/Applications/Ollama.app/Contents/Resources/ollama" "/Applications/Ollama.app/Contents/Resources/ollama" "$(command -v ollama 2>/dev/null)"; do
      if [ -n "$b" ] && [ -x "$b" ]; then OLLAMA_BIN="$b"; break; fi
    done
    if [ -n "$OLLAMA_BIN" ]; then
      OLLAMA_MODELS="${STEWARD_OLLAMA_MODELS:-$HOME/.ollama/models}" OLLAMA_KEEP_ALIVE=24h nohup "$OLLAMA_BIN" serve >> "$DIR/ollama.log" 2>&1 < /dev/null &
      for i in $(seq 1 30); do up http://127.0.0.1:11434/api/tags && break; sleep 1; done
    fi
  fi
fi

# 2. Steward server
if ! up http://127.0.0.1:8787/health; then
  PY="$HOME/.steward-venv/bin/python"
  if [ ! -x "$PY" ]; then
    python3 -m venv "$HOME/.steward-venv" && "$HOME/.steward-venv/bin/pip" install -q --disable-pip-version-check -r "$DIR/requirements.txt"
  fi
  cd "$DIR" && nohup "$PY" steward_server.py >> "$LOG" 2>&1 < /dev/null &
  for i in $(seq 1 30); do up http://127.0.0.1:8787/health && break; sleep 1; done
fi

# 3. Steward itself
open "$URL"
