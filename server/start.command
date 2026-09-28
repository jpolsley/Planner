#!/bin/bash
# Steward server for macOS and Linux. On a Mac, double-click this file (or run ./start.command).
cd "$(dirname "$0")"
if [ ! -f steward.env ]; then
  cp steward.env.example steward.env
  python3 - <<'PY'
import secrets, re, pathlib
p = pathlib.Path("steward.env"); key = secrets.token_urlsafe(24)
home = str(pathlib.Path.cwd().parent)  # keep docs/ and data/ next to this server folder (e.g. on a flash drive)
t = re.sub(r"^STEWARD_KEY=.*$", "STEWARD_KEY=" + key, p.read_text(), flags=re.M)
p.write_text(re.sub(r"^STEWARD_HOME=.*$", "STEWARD_HOME=" + home, t, flags=re.M))
print("\nYour new Steward key (enter it in Steward; it's also saved in steward.env):\n\n   " + key + "\n")
PY
fi
MODEL=$(grep -E '^MODEL=' steward.env | cut -d= -f2 | cut -d, -f1)
if command -v ollama >/dev/null 2>&1; then
  ollama list | grep -q "^${MODEL:-qwen3:32b}" || { echo "Downloading ${MODEL:-qwen3:32b} (one time, about 20 GB)…"; ollama pull "${MODEL:-qwen3:32b}"; }
else
  echo "⚠️  Ollama isn't installed. Get it from https://ollama.com, then run this again."
fi
# Python packages live in your home folder (flash drives can't hold them, and they differ per computer).
VENV="$HOME/.steward-venv"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --disable-pip-version-check -r requirements.txt
exec "$VENV/bin/python" steward_server.py
