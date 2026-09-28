#!/bin/bash
# Steward server for macOS and Linux. On a Mac, double-click this file (or run ./start.command).
cd "$(dirname "$0")"
if [ ! -f steward.env ]; then
  cp steward.env.example steward.env
  python3 - <<'PY'
import secrets, re, pathlib
p = pathlib.Path("steward.env"); key = secrets.token_urlsafe(24)
p.write_text(re.sub(r"^STEWARD_KEY=.*$", "STEWARD_KEY=" + key, p.read_text(), flags=re.M))
print("\nYour new Steward key (enter it in Steward; it's also saved in steward.env):\n\n   " + key + "\n")
PY
fi
MODEL=$(grep -E '^MODEL=' steward.env | cut -d= -f2 | cut -d, -f1)
if command -v ollama >/dev/null 2>&1; then
  ollama list | grep -q "^${MODEL:-qwen3:32b}" || { echo "Downloading ${MODEL:-qwen3:32b} (one time, about 20 GB)…"; ollama pull "${MODEL:-qwen3:32b}"; }
else
  echo "⚠️  Ollama isn't installed. Get it from https://ollama.com, then run this again."
fi
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --disable-pip-version-check -r requirements.txt
exec .venv/bin/python steward_server.py
