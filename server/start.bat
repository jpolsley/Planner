@echo off
rem Steward server for Windows. Double-click this file.
cd /d "%~dp0"
if not exist steward.env (
  copy steward.env.example steward.env >nul
  python -c "import secrets,re,pathlib;p=pathlib.Path('steward.env');k=secrets.token_urlsafe(24);p.write_text(re.sub(r'^STEWARD_KEY=.*$','STEWARD_KEY='+k,p.read_text(),flags=re.M));print('\nYour new Steward key (also saved in steward.env):\n\n   '+k+'\n')"
)
where ollama >nul 2>nul && (ollama list | findstr /b "qwen3:32b" >nul || ollama pull qwen3:32b) || echo Ollama isn't installed. Get it from https://ollama.com, then run this again.
if not exist .venv python -m venv .venv
.venv\Scripts\pip install -q --disable-pip-version-check -r requirements.txt
.venv\Scripts\python steward_server.py
pause
