"""Steward server: runs on your own computer, with no Hugging Face.

- relays chats to a local model through Ollama (default: qwen3:32b), with your documents added
- keeps your planner in sync across devices, saved as a file on this computer
- reads calendar links (.ics) so your meetings show up in Steward

Start:  python steward_server.py      (see README.md in this folder)
Settings come from environment variables or a steward.env file next to this script:
  STEWARD_KEY   a long passphrase; enter the same one in Steward (required)
  MODEL         Ollama model name (default qwen3:32b); comma-separate to add fallbacks
  LLM_URL       OpenAI-compatible chat endpoint (default http://127.0.0.1:11434/v1/chat/completions)
  STEWARD_HOME  folder for docs/ and data/ (default ~/Steward)
  PORT          default 8787 (HOST default 127.0.0.1; use Tailscale Serve for your phone)
"""
import asyncio
import base64
import binascii
import json
import os
import re
import secrets
import shutil
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
_env = HERE / "steward.env"
if _env.exists():
    for _line in _env.read_text().splitlines():
        if "=" in _line and not _line.lstrip().startswith("#"):
            k, v = _line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

STEWARD_KEY = os.environ.get("STEWARD_KEY", "")
MODELS = [m.strip() for m in os.environ.get("MODEL", "qwen3:32b").split(",") if m.strip()]
LLM_URL = os.environ.get("LLM_URL", "http://127.0.0.1:11434/v1/chat/completions")
LLM_KEY = os.environ.get("LLM_KEY", "")
# Talking to Ollama's own API lets the server keep the model loaded, give it enough context for Steward's
# briefing, and switch Qwen3's thinking off properly. Any other endpoint uses the OpenAI format.
OLLAMA = re.match(r"^(https?://[^/]+:11434)", LLM_URL)
OLLAMA_BASE = OLLAMA.group(1) if OLLAMA and os.environ.get("OLLAMA_NATIVE", "1") != "0" else ""
NUM_CTX = int(os.environ.get("NUM_CTX", "12288"))
KEEP_ALIVE = os.environ.get("KEEP_ALIVE", "24h")
HOME = Path(os.path.expanduser(os.environ.get("STEWARD_HOME", "~/Steward")))
DOCS_DIR = HOME / "docs"
DATA_FILE = HOME / "data" / "steward.json"
DOCS_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Steward")
# Steward is served from GitHub Pages, so it calls this server cross-origin. The Steward key is what
# protects it; the server also only listens on this computer unless you change HOST.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=["X-Steward-Model"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Chrome asks before a public website may call a server on this computer (Private Network Access).
    res = await call_next(request)
    if request.method == "OPTIONS":
        res.headers["Access-Control-Allow-Private-Network"] = "true"
    return res


# ---------- documents ----------
def _read(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        from pypdf import PdfReader
        return "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    return path.read_text(encoding="utf-8", errors="ignore")


def _load_chunks():
    chunks = []
    if not DOCS_DIR.exists():
        return chunks
    for path in sorted(DOCS_DIR.rglob("*")):
        if path.suffix.lower() not in {".txt", ".md", ".pdf"} or path.name.lower() == "readme.md":
            continue
        try:
            text = re.sub(r"\s+", " ", _read(path)).strip()
        except Exception as e:  # a bad file shouldn't take the Space down
            print(f"Skipping {path.name}: {e}")
            continue
        for i in range(0, len(text), 900):
            piece = text[i:i + 1000]
            if piece:
                chunks.append({"source": path.name, "text": piece, "terms": _terms(piece), "name_terms": _terms(re.sub(r"[_().\d-]+", " ", path.stem))})
    print(f"Loaded {len(chunks)} passages from {DOCS_DIR}")
    return chunks


STOP = set("the and for are but not you your with this that have from was were will what when where which who how can our they them their about into than then just also more".split())


def _terms(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9']{3,}", text.lower()) if w not in STOP}


CHUNKS = _load_chunks()


def relevant_passages(query: str, limit: int = 6):
    """Score passages by shared words, with a strong boost when the question names the file
    ("my job description" -> "Job Description_.txt"). Returns the best few with any real match."""
    q = _terms(query)
    if not q or not CHUNKS:
        return []
    def score(c):
        body = len(q & c["terms"])
        name = len(q & c["name_terms"])
        return body + (6 * name if name else 0)
    scored = sorted(((score(c), i, c) for i, c in enumerate(CHUNKS)), key=lambda x: (-x[0], x[1]))
    top = scored[0][0] if scored else 0
    best = [c for sc, _, c in scored[:limit] if sc >= max(1, top / 2)]
    # a named file: keep its passages in reading order
    return sorted(best, key=lambda c: (c["source"], CHUNKS.index(c)))


def documents_note():
    names = sorted({c["source"] for c in CHUNKS})
    return ("The user has uploaded these documents: " + ", ".join(names) + ". "
            "Relevant passages are included below when they match the conversation; if the user asks about a document "
            "and no passage is shown, say which document you would need and ask them to mention it by name.") if names else ""


# ---------- API ----------
def _authorized(request: Request) -> bool:
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    return bool(STEWARD_KEY) and secrets.compare_digest(given, STEWARD_KEY)


@app.get("/health")
def health():
    return {"ok": True, "configured": bool(STEWARD_KEY), "documents": len({c["source"] for c in CHUNKS}), "models": MODELS,
            "features": ["sync", "calendar", "events", "docs"] + (["workcal"] if WORK_FEED_URL else []) + (["email"] if MAIL_FEED_URL else []), "sync": str(DATA_FILE), "server": "local"}


class ThinkFilter:
    """Qwen3 may think out loud inside <think>…</think>; Steward only wants the answer."""
    def __init__(self):
        self.inside = False
        self.buf = ""

    def feed(self, text):
        self.buf += text
        out = ""
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]
                    return out
                self.buf = self.buf[end + 8:].lstrip()
                self.inside = False
            else:
                start = self.buf.find("<think>")
                if start < 0:
                    keep = max((i for i in range(1, 7) if self.buf.endswith("<think>"[:i])), default=0)
                    out += self.buf[:len(self.buf) - keep]
                    self.buf = self.buf[len(self.buf) - keep:]
                    return out
                out += self.buf[:start]
                self.buf = self.buf[start + 7:]
                self.inside = True
        return out


@app.post("/v1/chat/completions")
async def chat(request: Request):
    if not STEWARD_KEY:
        return JSONResponse({"error": "Set STEWARD_KEY in steward.env and restart the server."}, status_code=500)
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    body = await request.json()
    messages = [m for m in body.get("messages", []) if isinstance(m, dict) and m.get("role") in ("system", "user", "assistant")][-24:]
    if not messages:
        return JSONResponse({"error": "No messages."}, status_code=400)

    recent_user = [str(m["content"]) for m in messages if m["role"] == "user"][-2:]
    use_docs = body.get("use_docs", True) is not False
    passages = relevant_passages(" ".join(recent_user)) if use_docs else []
    note = ("\n\n" + documents_note()) if CHUNKS and use_docs else ""
    if passages:
        docs = "\n\n".join(f"[{p['source']}] {p['text']}" for p in passages)
        note += "\n\nRelevant passages from the user's documents (cite the file name when you use them):\n" + docs
    if messages[0]["role"] == "system":
        messages[0] = {"role": "system", "content": str(messages[0]["content"]) + note}
    elif note:
        messages.insert(0, {"role": "system", "content": note.strip()})
    # Qwen3: answer directly instead of spending minutes thinking first.
    if OLLAMA_BASE:
        return await _ollama_chat(messages, body)
    if any("qwen3" in m.lower() for m in MODELS) and messages[-1]["role"] == "user":
        messages[-1] = {**messages[-1], "content": str(messages[-1]["content"]) + " /no_think"}

    payload = {
        "messages": messages,
        "max_tokens": min(int(body.get("max_tokens", 400)), 1500),
        "temperature": max(0.1, min(float(body.get("temperature", 0.6)), 1.5)),
        "stream": True,
    }
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {LLM_KEY}"} if LLM_KEY else {})}
    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10))
    last_error = "no models configured"
    for model in MODELS:
        try:
            res = await client.send(client.build_request("POST", LLM_URL, headers=headers, json={**payload, "model": model}), stream=True)
        except httpx.ConnectError:
            await client.aclose()
            return JSONResponse({"error": "Ollama isn't running on this computer. Open the Ollama app and try again."}, status_code=502)
        if res.status_code == 200:
            async def relay(res=res):
                flt, buf = ThinkFilter(), ""
                try:
                    async for chunk in res.aiter_text():
                        buf += chunk
                        lines = buf.split("\n")
                        buf = lines.pop()
                        for line in lines:
                            data = line[5:].strip() if line.startswith("data:") else ""
                            if not data:
                                continue
                            if data == "[DONE]":
                                if flt.buf and not flt.inside:
                                    yield "data: " + json.dumps({"choices": [{"delta": {"content": flt.buf}}]}) + "\n\n"
                                    flt.buf = ""
                                yield "data: [DONE]\n\n"
                                continue
                            try:
                                j = json.loads(data)
                                delta = j["choices"][0].get("delta", {})
                                if delta.get("content"):
                                    delta["content"] = flt.feed(delta["content"])
                                    if not delta["content"]:
                                        continue
                                elif "reasoning" in delta or "reasoning_content" in delta:
                                    continue
                                yield "data: " + json.dumps(j) + "\n\n"
                            except Exception:
                                continue
                finally:
                    await res.aclose()
                    await client.aclose()
            return StreamingResponse(relay(), media_type="text/event-stream", headers={"X-Steward-Model": model})
        detail = (await res.aread()).decode(errors="ignore")[:300]
        await res.aclose()
        last_error = f"{model}: {res.status_code} {detail}"
        print("Model failed:", last_error)
        if res.status_code == 404:
            last_error = f"The model {model} isn't downloaded. Run: ollama pull {model}"
    await client.aclose()
    return JSONResponse({"error": last_error}, status_code=502)


async def _ollama_chat(messages, body):
    """Streams from Ollama's /api/chat and re-emits it in the OpenAI stream format Steward reads."""
    client = httpx.AsyncClient(timeout=httpx.Timeout(900, connect=10))
    last_error = "no models configured"
    for model in MODELS:
        payload = {"model": model, "messages": messages, "stream": True, "think": False, "keep_alive": KEEP_ALIVE,
                   "options": {"num_ctx": NUM_CTX, "num_predict": min(int(body.get("max_tokens", 400)), 1500),
                               "temperature": max(0.1, min(float(body.get("temperature", 0.6)), 1.5))}}
        try:
            res = await client.send(client.build_request("POST", OLLAMA_BASE + "/api/chat", json=payload), stream=True)
            if res.status_code == 400:
                detail = (await res.aread()).decode(errors="ignore")
                await res.aclose()
                if "think" in detail.lower():  # models without a thinking switch
                    payload.pop("think")
                    res = await client.send(client.build_request("POST", OLLAMA_BASE + "/api/chat", json=payload), stream=True)
                else:
                    last_error = f"{model}: 400 {detail[:200]}"
                    continue
        except httpx.ConnectError:
            await client.aclose()
            return JSONResponse({"error": "Ollama isn't running on this computer. Open the Ollama app and try again."}, status_code=502)
        if res.status_code == 200:
            async def relay(res=res):
                flt = ThinkFilter()
                sse = lambda text: "data: " + json.dumps({"choices": [{"delta": {"content": text}}]}) + "\n\n"
                try:
                    async for line in res.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            j = json.loads(line)
                        except Exception:
                            continue
                        if j.get("error"):
                            yield sse("\n[Error: " + str(j["error"]) + "]")
                            break
                        text = flt.feed((j.get("message") or {}).get("content") or "")
                        if text:
                            yield sse(text)
                        if j.get("done"):
                            break
                    if flt.buf and not flt.inside:
                        yield sse(flt.buf)
                    yield "data: [DONE]\n\n"
                finally:
                    await res.aclose()
                    await client.aclose()
            return StreamingResponse(relay(), media_type="text/event-stream", headers={"X-Steward-Model": model})
        detail = (await res.aread()).decode(errors="ignore")[:300]
        await res.aclose()
        last_error = f"The model {model} isn't downloaded. Run: ollama pull {model}" if res.status_code == 404 else f"{model}: {res.status_code} {detail}"
        print("Model failed:", last_error)
    await client.aclose()
    return JSONResponse({"error": last_error}, status_code=502)


# ---------- sync: one file on this computer holds the planner, shared by every device ----------
MAX_SYNC_BYTES = 20_000_000
STORE = {"rev": 0, "updated": 0, "data": None, "loaded": False, "error": "", "flush": None, "saved_rev": 0}
STORE_LOCK = asyncio.Lock()


def _load_store():
    if STORE["loaded"]:
        return
    if DATA_FILE.exists():
        doc = json.loads(DATA_FILE.read_text())
        STORE.update(rev=doc.get("rev", 0), updated=doc.get("updated", 0), data=doc.get("data"), saved_rev=doc.get("rev", 0))
    STORE["loaded"] = True


def _write_store():
    doc = {"rev": STORE["rev"], "updated": STORE["updated"], "data": STORE["data"]}
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc))
    tmp.replace(DATA_FILE)
    # one backup per day, last 14 kept
    day = DATA_FILE.parent / "backups" / (datetime.now().strftime("%Y-%m-%d") + ".json")
    day.parent.mkdir(exist_ok=True)
    if not day.exists():
        shutil.copy(DATA_FILE, day)
        for old in sorted(day.parent.glob("*.json"))[:-14]:
            old.unlink()
    STORE["saved_rev"] = doc["rev"]


async def _flush_soon(delay=3):
    await asyncio.sleep(delay)
    STORE["flush"] = None
    try:
        _write_store()
        STORE["error"] = ""
    except Exception as e:
        STORE["error"] = f"Couldn't save to {DATA_FILE}: {e}"
        print(STORE["error"])


def _sync_state():
    return {"rev": STORE["rev"], "updated": STORE["updated"], "saved": STORE["saved_rev"] == STORE["rev"], "error": STORE["error"]}


@app.get("/v1/sync")
async def sync_get(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    _load_store()
    return {**_sync_state(), "data": STORE["data"]}


@app.put("/v1/sync")
async def sync_put(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    raw = await request.body()
    if len(raw) > MAX_SYNC_BYTES:
        return JSONResponse({"error": "Your planner is too large to sync."}, status_code=413)
    body = json.loads(raw)
    _load_store()
    async with STORE_LOCK:
        if STORE["data"] is not None and int(body.get("base_rev", -1)) != STORE["rev"]:
            return JSONResponse({**_sync_state(), "data": STORE["data"]}, status_code=409)
        STORE.update(rev=STORE["rev"] + 1, updated=int(time.time() * 1000), data=body.get("data"))
        if STORE["flush"] is None:
            STORE["flush"] = asyncio.create_task(_flush_soon())
        return _sync_state()


# ---------- history: append-only events, one file per month ----------
EVENTS_DIR = HOME / "data" / "events"


_SEEN = None


def _seen_event_ids():
    global _SEEN
    if _SEEN is None:
        _SEEN = set()
        for path in sorted(EVENTS_DIR.glob("*.jsonl"))[-3:] if EVENTS_DIR.exists() else []:
            for line in path.read_text().splitlines():
                try:
                    _SEEN.add(json.loads(line)["id"])
                except Exception:
                    pass
    return _SEEN


@app.post("/v1/events")
async def events_post(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    body = await request.json()
    items = [e for e in body.get("events", []) if isinstance(e, dict) and e.get("id") and e.get("op")][:1000]
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    seen = _seen_event_ids()
    items = [e for e in items if e["id"] not in seen]  # a retried upload must not duplicate events
    received = int(time.time() * 1000)
    by_month = {}
    for e in items:
        seen.add(e["id"])
        e["received"] = received
        month = datetime.fromtimestamp(int(e.get("ts", time.time() * 1000)) / 1000).strftime("%Y-%m")
        by_month.setdefault(month, []).append(json.dumps(e, separators=(",", ":")))
    for month, lines in by_month.items():
        with open(EVENTS_DIR / f"{month}.jsonl", "a") as fh:
            fh.write("\n".join(lines) + "\n")
    return {"ok": True, "stored": len(items)}


# ---------- documents from the app ----------
DOC_TYPES = {".txt", ".md", ".pdf"}


def _doc_name(name: str) -> str:
    """A safe file name inside docs/: no folders, no hidden files, only the types Diana can read."""
    base = Path(str(name or "")).name.strip().lstrip(".")
    base = re.sub(r"[^\w .()&,'-]+", "_", base)[:120]
    if not base or Path(base).suffix.lower() not in DOC_TYPES or base.lower() == "readme.md":
        raise ValueError("Only .md, .txt and .pdf files can be added.")
    return base


def _reload_docs():
    global CHUNKS
    CHUNKS = _load_chunks()


@app.get("/v1/docs")
async def docs_list(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    counts = {}
    for c in CHUNKS:
        counts[c["source"]] = counts.get(c["source"], 0) + 1
    out = []
    for path in sorted(DOCS_DIR.iterdir()):
        if path.is_file() and path.suffix.lower() in DOC_TYPES and path.name.lower() != "readme.md":
            st = path.stat()
            out.append({"name": path.name, "size": st.st_size, "updated": int(st.st_mtime * 1000), "passages": counts.get(path.name, 0)})
    return {"docs": out}


@app.post("/v1/docs")
async def docs_add(request: Request):
    """Body: {"name": "about-me.md", "data": base64 of the file}. Replaces a file with the same name."""
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    body = await request.json()
    try:
        name = _doc_name(body.get("name"))
        raw = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, binascii.Error) as e:
        return JSONResponse({"error": str(e) or "That file couldn't be read."}, status_code=400)
    if not raw or len(raw) > 15 * 1024 * 1024:
        return JSONResponse({"error": "Files must be under 15 MB."}, status_code=400)
    tmp = DOCS_DIR / (".upload-" + secrets.token_hex(4))
    tmp.write_bytes(raw)
    tmp.replace(DOCS_DIR / name)
    _reload_docs()
    return {"ok": True, "name": name, "passages": sum(1 for c in CHUNKS if c["source"] == name)}


@app.delete("/v1/docs/{name}")
async def docs_remove(name: str, request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    try:
        path = DOCS_DIR / _doc_name(name)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if path.exists():
        path.unlink()
        _reload_docs()
    return {"ok": True}


@app.get("/v1/events")
async def events_get(request: Request, since: int = 0, limit: int = 2000):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    out = []
    for path in sorted(EVENTS_DIR.glob("*.jsonl")) if EVENTS_DIR.exists() else []:
        for line in path.read_text().splitlines():
            try:
                e = json.loads(line)
            except Exception:
                continue
            if int(e.get("ts", 0)) > since:
                out.append(e)
    out.sort(key=lambda e: e.get("ts", 0))
    return {"events": out[-max(1, min(limit, 20000)):]}


# ---------- calendars: read a calendar's secret .ics link and return the next few weeks ----------
def _ms(v):
    """Epoch ms for a timezone-aware time; a local ISO string for floating times and all-day dates."""
    if isinstance(v, datetime):
        return int(v.timestamp() * 1000) if v.tzinfo else v.strftime("%Y-%m-%dT%H:%M:%S")
    return v.strftime("%Y-%m-%dT00:00:00")


# ---------- work calendar feed (read-only) ----------
# A sanitized JSON snapshot of the work Outlook calendar, written hourly by Power Automate to OneDrive and shared with
# a view-only link. The link is a secret: it lives only in steward.env (DIANA_WORK_CALENDAR_FEED_URL) and never goes
# to the browser. Steward asks for it as the calendar address "steward:work".
WORK_FEED_URL = os.environ.get("DIANA_WORK_CALENDAR_FEED_URL", "").strip()
# Private/confidential events show with their real titles (it's your own calendar). Set DIANA_WORK_CALENDAR_HIDE_PRIVATE=1
# to show them only as "Private appointment". The old DIANA_WORK_CALENDAR_SHOW_PRIVATE=0 also hides them.
WORK_SHOW_PRIVATE = not (os.environ.get("DIANA_WORK_CALENDAR_HIDE_PRIVATE", "").strip().lower() in ("1", "true", "yes")
                         or os.environ.get("DIANA_WORK_CALENDAR_SHOW_PRIVATE", "").strip().lower() in ("0", "false", "no"))
WORK_CACHE = DATA_FILE.parent / "work-calendar.json"
WORK_TTL = 20 * 60
_WIN_TZ = {"Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York", "Mountain Standard Time": "America/Denver",
           "Pacific Standard Time": "America/Los_Angeles", "US Mountain Standard Time": "America/Phoenix", "UTC": "UTC", "Coordinated Universal Time": "UTC"}


def _work_url(url: str) -> str:
    """OneDrive/SharePoint view links open a web page; download=1 asks for the file itself."""
    if re.search(r"(sharepoint\.com|1drv\.ms|onedrive\.live\.com)", url, re.I) and not re.search(r"[?&]download=1", url):
        url += ("&" if "?" in url else "?") + "download=1"
    return url


def _work_time(v, tz_name=None):
    """Outlook times: '2026-10-03T14:00:00+00:00', '2026-10-03T14:00:00.0000000' (UTC), or {'dateTime','timeZone'}."""
    if isinstance(v, dict):
        return _work_time(v.get("dateTime"), v.get("timeZone"))
    if not v:
        return None
    t = str(v).strip().replace("Z", "+00:00")
    t = re.sub(r"(\.\d{1,6})\d*", r"\1", t)  # Outlook writes 7 fractional digits
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        zone = timezone.utc
        if tz_name:
            try:
                from zoneinfo import ZoneInfo
                zone = ZoneInfo(_WIN_TZ.get(tz_name, tz_name))
            except Exception:
                zone = timezone.utc
        d = d.replace(tzinfo=zone)
    return d


def _work_normalize(raw):
    """Feed → the same event shape the .ics importer returns. Raises ValueError if it isn't the expected JSON."""
    if isinstance(raw, str):
        raw = json.loads(raw)  # Compose may have written the array as a JSON string
    if isinstance(raw, dict):
        raw = raw.get("value", raw.get("events"))
    if not isinstance(raw, list):
        raise ValueError("the feed isn't a list of events")
    out = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        subject = str(e.get("subject") or "").strip()
        if re.match(r"^(canceled|cancelled)\s*:", subject, re.I) or e.get("isCancelled") is True:
            continue  # cancelled meetings
        show = str(e.get("showAs") or "").lower()
        if show == "free":
            continue  # doesn't block time, same as a "free" .ics event
        s, en = _work_time(e.get("start")), _work_time(e.get("end"))
        if not s:
            continue
        all_day = bool(e.get("isAllDay"))
        private = str(e.get("sensitivity") or "").lower() in ("private", "confidential")
        title = "Private appointment" if private and not WORK_SHOW_PRIVATE else (subject or "Busy")
        if all_day:
            start = s.strftime("%Y-%m-%dT00:00:00")
            end = (en or s + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00")
        else:
            start = int(s.timestamp() * 1000)
            end = int((en or s + timedelta(minutes=30)).timestamp() * 1000)
        loc = e.get("location")
        if isinstance(loc, dict):
            loc = loc.get("displayName", "")
        uid = str(e.get("id") or "") or subject + str(start)
        out.append({"uid": _short_id(uid), "title": title, "start": start, "end": end,
                    "allDay": all_day, "location": "" if private and not WORK_SHOW_PRIVATE else str(loc or ""),
                    "tentative": show == "tentative"})
    return out


def _short_id(text: str) -> str:
    import hashlib
    return "w" + hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:16]


def _work_cache_read():
    try:
        return json.loads(WORK_CACHE.read_text())
    except Exception:
        return {}


async def _work_refresh(force=False):
    """Fetch the feed if the cached copy is old. A failed fetch keeps the last good snapshot and records the error."""
    cache = _work_cache_read()
    now = int(time.time())
    if not WORK_FEED_URL:
        return cache
    if not force and cache.get("checked", 0) > now - WORK_TTL:
        return cache
    cache["checked"] = now
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            res = await client.get(_work_url(WORK_FEED_URL), headers={"User-Agent": "Steward calendar"})
        if res.status_code != 200:
            raise ValueError(f"the feed answered {res.status_code}")
        text = res.content.decode("utf-8-sig", "ignore").strip()
        if text.startswith("<"):
            raise ValueError("the link returned a web page, not the JSON file (is it a view link to diana-calendar.json?)")
        events = _work_normalize(json.loads(text))
        cache.update({"events": events, "synced": now, "error": None})
    except Exception as e:
        cache["error"] = str(e)[:300]
    try:
        WORK_CACHE.write_text(json.dumps(cache))
    except Exception:
        pass
    return cache


# ---------- work email feed (read-only) ----------
# Up to ~100 Inbox + ~100 Sent messages (previews only), written hourly by Power Automate to OneDrive as diana-email.json
# and shared with a view-only link kept only in steward.env (DIANA_WORK_EMAIL_FEED_URL). Code works out the facts
# (threads, who spoke last, whether Justin replied, how long someone has waited, internal/external, automated or
# human); Diana judges meaning and drafts replies. Nothing is ever sent.
MAIL_FEED_URL = os.environ.get("DIANA_WORK_EMAIL_FEED_URL", "").strip()
MAIL_DOMAINS = [d.strip().lower() for d in os.environ.get("DIANA_WORK_EMAIL_DOMAINS", "salvationarmy.org").split(",") if d.strip()]
MAIL_CACHE = DATA_FILE.parent / "work-email.json"
_BANNER = re.compile(r"^\s*(\[?external\]?:?\s*)?(caution|warning|notice)?\s*:?\s*(this (e-?mail|message) (originated|came|was sent) from (outside|an external)[^.]*\.([^.]*(click|open|attachments|sender|safe|trust)[^.]*\.){0,3})\s*", re.I)
_AUTO_FROM = re.compile(r"(no-?reply|do-?not-?reply|notification|notifications|mailer|newsletter|news@|marketing|bounce|alerts?@|system|automated|calendar-notification|support@|info@|updates?@|digest)", re.I)
_PROMO = re.compile(r"(unsubscribe|view (this|it) in your browser|newsletter|webinar|% off|sale ends|limited time|register now|special offer|promo|your (order|receipt|invoice)|has been shipped|password reset|verification code)", re.I)
_ASK = re.compile(r"(\?|\bcan you\b|\bcould you\b|\bwould you\b|\bplease\b|\blet me know\b|\bneed\b|\bwhen (can|will|do)\b|\bwhat (time|date|do you)\b|\bthoughts\b|\bconfirm\b|\bapprove\b|\bsend (me|over)\b|\bfollow(ing)? up\b|\bany update\b)", re.I)


def _addr(v):
    """Outlook gives 'Name <a@b>', 'a@b', a list, or {emailAddress:{name,address}}."""
    if isinstance(v, list):
        return [x for x in (_addr(i) for i in v) if x]
    if isinstance(v, dict):
        e = v.get("emailAddress", v)
        return {"name": str(e.get("name") or "").strip(), "address": str(e.get("address") or "").strip().lower()}
    t = str(v or "").strip()
    if not t:
        return None
    if ";" in t:
        return [x for x in (_addr(i) for i in t.split(";")) if x]
    m = re.match(r'^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$', t)
    return {"name": m.group(1).strip(), "address": m.group(2).strip().lower()} if m else {"name": "", "address": t.lower()}


def _as_list(v):
    a = _addr(v)
    return a if isinstance(a, list) else ([a] if a else [])


def _internal(address):
    dom = address.split("@")[-1] if "@" in address else ""
    return any(dom == d or dom.endswith("." + d) for d in MAIL_DOMAINS)


def _mail_normalize(raw):
    if isinstance(raw, str):
        raw = json.loads(raw)
    if isinstance(raw, dict):
        raw = raw.get("value", raw.get("messages"))
    if not isinstance(raw, list):
        raise ValueError("the email feed isn't a list of messages")
    msgs = []
    for e in raw:
        if not isinstance(e, dict):
            continue
        t = _work_time(e.get("receivedDateTime") or e.get("sentDateTime"))
        if not t:
            continue
        frm = _addr(e.get("from"))
        frm = frm[0] if isinstance(frm, list) and frm else frm or {"name": "", "address": ""}
        preview = re.sub(r"\s+", " ", str(e.get("bodyPreview") or "")).strip()
        preview = _BANNER.sub("", preview, count=1).strip()
        msgs.append({"id": _short_id(str(e.get("internetMessageId") or e.get("id") or "") + str(t)), "conv": str(e.get("conversationId") or e.get("id") or ""),
                     "ts": int(t.timestamp() * 1000), "folder": "sent" if str(e.get("sourceFolder") or "").lower() == "sent" else "inbox",
                     "from": frm, "to": _as_list(e.get("toRecipients")), "cc": _as_list(e.get("ccRecipients")),
                     "subject": str(e.get("subject") or "(no subject)").strip()[:300], "preview": preview[:600],
                     "read": bool(e.get("isRead")), "importance": str(e.get("importance") or "normal").lower(), "attach": bool(e.get("hasAttachments"))})
    # de-duplicate (a message can appear in both folders when you email yourself) and sort
    seen, out = set(), []
    for m in sorted(msgs, key=lambda x: x["ts"]):
        k = (m["id"], m["folder"])
        if k not in seen:
            seen.add(k); out.append(m)
    return out


def _mail_me(msgs):
    """The user's own address: whoever sends the Sent Items."""
    counts = {}
    for m in msgs:
        if m["folder"] == "sent" and m["from"].get("address"):
            counts[m["from"]["address"]] = counts.get(m["from"]["address"], 0) + 1
    return max(counts, key=counts.get) if counts else ""


def _mail_kind(m):
    a = m["from"].get("address", "")
    if _AUTO_FROM.search(a) or _AUTO_FROM.search(m["from"].get("name", "")):
        return "automated"
    if _PROMO.search(m["preview"]) or _PROMO.search(m["subject"]):
        return "newsletter"
    return "person"


def _mail_threads(msgs):
    me = _mail_me(msgs)
    now = int(time.time() * 1000)
    convs = {}
    for m in msgs:
        convs.setdefault(m["conv"], []).append(m)
    threads = []
    for conv, ms in convs.items():
        ms.sort(key=lambda x: x["ts"])
        last = ms[-1]
        last_sent = max((x["ts"] for x in ms if x["folder"] == "sent"), default=0)
        inbound_after = [x for x in ms if x["folder"] == "inbox" and x["ts"] > last_sent]
        first_in = inbound_after[0] if inbound_after else None
        latest_in = inbound_after[-1] if inbound_after else None
        kind = _mail_kind(latest_in) if latest_in else "person"
        direct = bool(latest_in) and (not me or any(r.get("address") == me for r in latest_in["to"]))
        if last["folder"] == "sent":
            state = "USER_REPLIED"
        elif not latest_in:
            state = "UNKNOWN"
        elif kind != "person":
            state = "LIKELY_RESOLVED"  # automated or newsletter: nobody is waiting
        elif not direct:
            state = "LIKELY_RESOLVED"  # you were only copied
        else:
            state = "AWAITING_USER_REPLY"
        people = {}
        for x in ms:
            if x["folder"] == "inbox" and x["from"].get("address"):
                people[x["from"]["address"]] = x["from"].get("name") or x["from"]["address"]
        sender = latest_in["from"] if latest_in else last["from"]
        ask = bool(latest_in) and bool(_ASK.search(latest_in["preview"]) or _ASK.search(latest_in["subject"]))
        waiting_h = round((now - first_in["ts"]) / 3600000, 1) if first_in and state == "AWAITING_USER_REPLY" else 0
        score = 0
        if state == "AWAITING_USER_REPLY":
            score = 50 + (20 if ask else 0) + (10 if latest_in["importance"] == "high" else 0) + min(20, len(inbound_after) * 6) + min(20, waiting_h / 6)
            if not latest_in["read"]:
                score += 5
        threads.append({"id": _short_id(conv), "conv": conv, "subject": ms[0]["subject"], "state": state, "kind": kind,
                        "from": sender, "internal": _internal(sender.get("address", "")), "direct": direct, "ask": ask,
                        "waiting_hours": waiting_h, "followups": max(0, len(inbound_after) - 1), "last_ts": last["ts"],
                        "last_from_me": last["folder"] == "sent", "count": len(ms), "people": list(people.values())[:6],
                        "latest_preview": (latest_in or last)["preview"][:400], "score": round(score, 1)})
    threads.sort(key=lambda t: (-t["score"], -t["last_ts"]))
    return me, threads


def _mail_cache_read():
    try:
        return json.loads(MAIL_CACHE.read_text())
    except Exception:
        return {}


async def _feed_get(url):
    async with httpx.AsyncClient(timeout=40, follow_redirects=True) as client:
        res = await client.get(_work_url(url), headers={"User-Agent": "Steward"})
    if res.status_code != 200:
        raise ValueError(f"the feed answered {res.status_code}")
    text = res.content.decode("utf-8-sig", "ignore").strip()
    if text.startswith("<"):
        raise ValueError("the link returned a web page, not the JSON file (is it a view link to the .json file?)")
    return json.loads(text)


async def _mail_refresh(force=False):
    cache = _mail_cache_read()
    now = int(time.time())
    if not MAIL_FEED_URL or (not force and cache.get("checked", 0) > now - WORK_TTL):
        return cache
    cache["checked"] = now
    try:
        msgs = _mail_normalize(await _feed_get(MAIL_FEED_URL))
        me, threads = _mail_threads(msgs)
        cache.update({"messages": msgs, "threads": threads, "me": me, "synced": now, "error": None})
    except Exception as e:
        cache["error"] = str(e)[:300]
    try:
        MAIL_CACHE.write_text(json.dumps(cache))
        os.chmod(MAIL_CACHE, 0o600)
    except Exception:
        pass
    return cache


def _mail_unauth(request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    if not MAIL_FEED_URL:
        return JSONResponse({"error": "No work email feed is set on your Steward server (DIANA_WORK_EMAIL_FEED_URL in steward.env)."}, status_code=400)
    return None


@app.get("/v1/email/status")
async def email_status(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    c = await _mail_refresh()
    th = c.get("threads") or []
    return {"configured": bool(MAIL_FEED_URL), "synced": c.get("synced"), "messages": len(c.get("messages") or []), "threads": len(th),
            "awaiting": sum(1 for t in th if t["state"] == "AWAITING_USER_REPLY"), "error": c.get("error")}


@app.get("/v1/email/attention")
async def email_attention(request: Request, limit: int = 8):
    bad = _mail_unauth(request)
    if bad:
        return bad
    c = await _mail_refresh()
    th = [t for t in (c.get("threads") or []) if t["state"] == "AWAITING_USER_REPLY"]
    return {"synced": c.get("synced"), "stale": bool(c.get("error")), "threads": th[:max(1, min(limit, 25))], "total": len(th)}


@app.get("/v1/email/search")
async def email_search(request: Request, q: str = "", limit: int = 10):
    bad = _mail_unauth(request)
    if bad:
        return bad
    c = await _mail_refresh()
    terms = [w for w in re.findall(r"[\w@.'-]{2,}", q.lower()) if w not in STOP]
    def hay(t):
        return " ".join([t["subject"], t["latest_preview"], t["from"].get("name", ""), t["from"].get("address", ""), " ".join(t["people"])]).lower()
    th = c.get("threads") or []
    hits = [(sum(w in hay(t) for w in terms), t) for t in th] if terms else [(1, t) for t in th]
    hits = [t for sc, t in sorted(hits, key=lambda x: (-x[0], -x[1]["last_ts"])) if sc > 0]
    return {"synced": c.get("synced"), "threads": hits[:max(1, min(limit, 25))]}


@app.get("/v1/email/thread")
async def email_thread(request: Request, id: str = ""):
    bad = _mail_unauth(request)
    if bad:
        return bad
    c = await _mail_refresh()
    t = next((x for x in (c.get("threads") or []) if x["id"] == id), None)
    if not t:
        return JSONResponse({"error": "No conversation with that id."}, status_code=404)
    ms = [m for m in (c.get("messages") or []) if m["conv"] == t["conv"]]
    return {"thread": t, "me": c.get("me"), "messages": [{"when": m["ts"], "folder": m["folder"], "from": m["from"], "to": m["to"], "cc": m["cc"], "subject": m["subject"], "preview": m["preview"], "attach": m["attach"]} for m in ms][-12:]}


@app.get("/v1/workcal")
async def workcal_status(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    c = await _work_refresh()
    return {"configured": bool(WORK_FEED_URL), "synced": c.get("synced"), "count": len(c.get("events") or []), "error": c.get("error")}


@app.post("/v1/calendar")
async def calendar(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    body = await request.json()
    url = str(body.get("url", "")).strip()
    if url == "steward:work":
        if not WORK_FEED_URL:
            return JSONResponse({"error": "No work calendar feed is set on your Steward server (DIANA_WORK_CALENDAR_FEED_URL in steward.env)."}, status_code=400)
        c = await _work_refresh()
        if not c.get("events") and c.get("error"):
            return JSONResponse({"error": "Couldn't read the work calendar feed: " + c["error"]}, status_code=502)
        return {"name": "Work calendar", "events": (c.get("events") or [])[:1500], "synced": c.get("synced"), "stale": bool(c.get("error"))}
    url = re.sub(r"^webcals?://", "https://", url, flags=re.I)
    if not re.match(r"^https?://", url, re.I):
        return JSONResponse({"error": "That isn't a calendar link. Copy the one ending in .ics."}, status_code=400)
    days = max(1, min(int(body.get("days", 28)), 90))
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            res = await client.get(url, headers={"User-Agent": "Steward calendar"})
        if res.status_code != 200:
            return JSONResponse({"error": f"The calendar link answered {res.status_code}."}, status_code=502)
        import icalendar
        import recurring_ical_events
        cal = icalendar.Calendar.from_ical(res.content)
        start = datetime.now(timezone.utc) - timedelta(days=1)
        items = recurring_ical_events.of(cal).between(start, start + timedelta(days=days + 1))
    except Exception as e:
        return JSONResponse({"error": f"Couldn't read that calendar: {e}"}, status_code=502)
    out = []
    for ev in items:
        s, e = ev.get("DTSTART"), ev.get("DTEND")
        if s is None:
            continue
        s = s.dt
        e = e.dt if e is not None else (s + timedelta(days=1) if not isinstance(s, datetime) else s + timedelta(minutes=30))
        if str(ev.get("TRANSP", "")).upper() == "TRANSPARENT" and isinstance(s, datetime):
            continue  # marked "free": doesn't block time
        out.append({"uid": str(ev.get("UID", "")), "title": str(ev.get("SUMMARY", "Busy")) or "Busy",
                    "start": _ms(s), "end": _ms(e), "allDay": not isinstance(s, datetime),
                    "location": str(ev.get("LOCATION", "") or "")})
    name = str(cal.get("X-WR-CALNAME", "") or "")
    return {"name": name, "events": out[:800]}


# ---------- status page ----------
@app.get("/", response_class=HTMLResponse)
def status_page():
    docs = sorted({c["source"] for c in CHUNKS})
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;")
    status = "✅ Ready. In Steward, connect to this server's address with your STEWARD_KEY." if STEWARD_KEY else "⚠️ Set STEWARD_KEY in steward.env, then restart."
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steward server</title><style>body{{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#e6e6e6;background:#0b0b0b}}code{{background:#1c1c1c;padding:1px 5px;border-radius:4px}}</style></head><body>
<h1>Steward server</h1><p><b>Status:</b> {status}</p>
<p><b>Model:</b> {esc(", ".join(MODELS))} via <code>{esc(OLLAMA_BASE + "/api/chat" if OLLAMA_BASE else LLM_URL)}</code>{(" · context " + str(NUM_CTX) + " · kept loaded " + KEEP_ALIVE) if OLLAMA_BASE else ""}</p>
<p><b>Planner saved to:</b> <code>{esc(str(DATA_FILE))}</code>{(" · ⚠️ " + esc(STORE["error"])) if STORE["error"] else ""}</p>
<p><b>Documents</b> (add them in Steward under Diana → What I know, or put .txt, .md or .pdf files in <code>{esc(str(DOCS_DIR))}</code> and restart): {esc(", ".join(docs)) if docs else "none yet"}</p>
</body></html>"""


if __name__ == "__main__":
    host, port = os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8787"))
    if not STEWARD_KEY:
        print("⚠️  No STEWARD_KEY yet. Copy steward.env.example to steward.env and set one.")
    print(f"Steward server on http://{host}:{port}  ·  model {', '.join(MODELS)}  ·  data in {HOME}")
    uvicorn.run(app, host=host, port=port, log_level="warning")
