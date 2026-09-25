"""Steward's own Hugging Face Space.

A small server between the Steward app and Hugging Face:
- keeps the Hugging Face token here, as a Space secret, so it never reaches a browser
- only answers requests that carry the STEWARD_KEY secret
- adds the most relevant passages from the files in docs/ to each chat
- streams replies from a large hosted model, trying the next model if one is unavailable

Runs on a free Gradio Space using Gradio's Server mode (gr.Server is a FastAPI app that Spaces launches).
- keeps your planner in sync across devices, saved to a private Hugging Face dataset
- reads calendar links (.ics) so your real meetings show up in Steward

Space secrets: HF_TOKEN (fine-grained, "Make calls to Inference Providers"), STEWARD_KEY (any long passphrase).
For sync, HF_TOKEN also needs write access to your repos (or add a separate HF_WRITE_TOKEN secret).
Optional variables: MODELS (comma-separated model ids), STEWARD_DATA (dataset id, default <you>/steward-data).
Browser access (CORS) is handled by Gradio itself; the STEWARD_KEY is what keeps the Space private.
"""
import asyncio
import json
import os
import re
import secrets
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
# Spaces put a Node page-rendering proxy in front of Gradio apps by default; this API doesn't need it.
os.environ.setdefault("GRADIO_SSR_MODE", "false")

import gradio as gr
from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

HF_TOKEN = os.environ.get("HF_TOKEN", "")
STEWARD_KEY = os.environ.get("STEWARD_KEY", "")
MODELS = [m.strip() for m in os.environ.get(
    "MODELS", "Qwen/Qwen2.5-72B-Instruct,meta-llama/Llama-3.3-70B-Instruct,Qwen/Qwen2.5-7B-Instruct").split(",") if m.strip()]
ROUTER = os.environ.get("HF_ROUTER", "https://router.huggingface.co/v1/chat/completions")
DOCS_DIR = Path(__file__).parent / "docs"

app = gr.Server(title="Steward")


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
    print(f"Loaded {len(chunks)} passages from docs/")
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
    return {"ok": True, "configured": bool(HF_TOKEN and STEWARD_KEY), "documents": len({c["source"] for c in CHUNKS}), "models": MODELS,
            "features": ["sync", "calendar"], "sync": DATA_REPO or "this server only (temporary)"}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    if not HF_TOKEN or not STEWARD_KEY:
        return JSONResponse({"error": "The Space is missing its HF_TOKEN or STEWARD_KEY secret."}, status_code=500)
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
    if note:
        if messages[0]["role"] == "system":
            messages[0] = {"role": "system", "content": str(messages[0]["content"]) + note}
        else:
            messages.insert(0, {"role": "system", "content": note.strip()})

    payload = {
        "messages": messages,
        "max_tokens": min(int(body.get("max_tokens", 400)), 1200),
        "temperature": max(0.1, min(float(body.get("temperature", 0.6)), 1.5)),
        "stream": True,
    }
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    client = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15))

    # Find the first model that accepts the request, then stream its reply straight through.
    last_error = "no models configured"
    for model in MODELS:
        req = client.build_request("POST", ROUTER, headers=headers, json={**payload, "model": model})
        res = await client.send(req, stream=True)
        if res.status_code == 200:
            async def relay(res=res):
                try:
                    async for chunk in res.aiter_raw():
                        yield chunk
                finally:
                    await res.aclose()
                    await client.aclose()
            return StreamingResponse(relay(), media_type="text/event-stream", headers={"X-Steward-Model": model})
        detail = (await res.aread()).decode(errors="ignore")[:300]
        await res.aclose()
        last_error = f"{model}: {res.status_code} {detail}"
        print("Model failed:", last_error)
        if res.status_code in (401, 402):  # bad token or credits used up: other models won't help
            break
    await client.aclose()
    status = 402 if " 402 " in last_error else 401 if " 401 " in last_error else 502
    return JSONResponse({"error": last_error}, status_code=status)


# ---------- sync: one private dataset file holds the planner, shared by every device ----------
DATA_REPO = os.environ.get("STEWARD_DATA") or (f"{os.environ['SPACE_AUTHOR_NAME']}/steward-data" if os.environ.get("SPACE_AUTHOR_NAME") else "")
DATA_TOKEN = os.environ.get("HF_WRITE_TOKEN") or HF_TOKEN
LOCAL_DATA = Path(os.environ.get("STEWARD_DATA_FILE", "/tmp/steward-sync.json"))  # used when not on a Space
MAX_SYNC_BYTES = 8_000_000
STORE = {"rev": 0, "updated": 0, "data": None, "loaded": False, "error": "", "flush": None, "saved_rev": 0}
STORE_LOCK = asyncio.Lock()


def _hub_read():
    from huggingface_hub import HfApi, hf_hub_download
    from huggingface_hub.utils import EntryNotFoundError, RepositoryNotFoundError
    api = HfApi(token=DATA_TOKEN)
    try:
        path = hf_hub_download(DATA_REPO, "steward.json", repo_type="dataset", token=DATA_TOKEN, force_download=True)
        return json.loads(Path(path).read_text())
    except RepositoryNotFoundError:
        api.create_repo(DATA_REPO, repo_type="dataset", private=True, exist_ok=True)
        return None
    except EntryNotFoundError:
        return None


def _hub_write(doc):
    from huggingface_hub import HfApi
    api = HfApi(token=DATA_TOKEN)
    api.create_repo(DATA_REPO, repo_type="dataset", private=True, exist_ok=True)
    api.upload_file(path_or_fileobj=json.dumps(doc).encode(), path_in_repo="steward.json", repo_id=DATA_REPO,
                    repo_type="dataset", commit_message=f"Steward sync {doc['rev']}")


async def _ensure_loaded():
    if STORE["loaded"]:
        return
    try:
        if DATA_REPO:
            doc = await asyncio.to_thread(_hub_read)
        else:
            doc = json.loads(LOCAL_DATA.read_text()) if LOCAL_DATA.exists() else None
        if doc:
            STORE.update(rev=doc.get("rev", 0), updated=doc.get("updated", 0), data=doc.get("data"), saved_rev=doc.get("rev", 0))
        STORE["error"] = ""
        STORE["loaded"] = True
    except Exception as e:
        STORE["error"] = f"Couldn't open {DATA_REPO or LOCAL_DATA}: {e}"
        print(STORE["error"])
        raise


async def _flush_soon(delay=20):
    """Saves at most every `delay` seconds, so a burst of edits becomes one dataset commit."""
    await asyncio.sleep(delay)
    STORE["flush"] = None
    doc = {"rev": STORE["rev"], "updated": STORE["updated"], "data": STORE["data"]}
    try:
        if DATA_REPO:
            await asyncio.to_thread(_hub_write, doc)
        else:
            LOCAL_DATA.write_text(json.dumps(doc))
        STORE["saved_rev"] = doc["rev"]
        STORE["error"] = ""
    except Exception as e:
        STORE["error"] = f"Couldn't save to {DATA_REPO or LOCAL_DATA}: {e}"
        print(STORE["error"])
        if STORE["flush"] is None:
            STORE["flush"] = asyncio.create_task(_flush_soon(120))


def _sync_state():
    return {"rev": STORE["rev"], "updated": STORE["updated"], "saved": STORE["saved_rev"] == STORE["rev"], "error": STORE["error"]}


@app.get("/v1/sync")
async def sync_get(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    try:
        await _ensure_loaded()
    except Exception:
        return JSONResponse({"error": STORE["error"]}, status_code=503)
    return {**_sync_state(), "data": STORE["data"]}


@app.put("/v1/sync")
async def sync_put(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    raw = await request.body()
    if len(raw) > MAX_SYNC_BYTES:
        return JSONResponse({"error": "Your planner is too large to sync."}, status_code=413)
    body = json.loads(raw)
    try:
        await _ensure_loaded()
    except Exception:
        return JSONResponse({"error": STORE["error"]}, status_code=503)
    async with STORE_LOCK:
        if STORE["data"] is not None and int(body.get("base_rev", -1)) != STORE["rev"]:
            # another device saved first: send its version back so this one can merge
            return JSONResponse({**_sync_state(), "data": STORE["data"]}, status_code=409)
        STORE.update(rev=STORE["rev"] + 1, updated=int(time.time() * 1000), data=body.get("data"))
        if STORE["flush"] is None:
            STORE["flush"] = asyncio.create_task(_flush_soon())
        return _sync_state()


# ---------- calendars: read a calendar's secret .ics link and return the next few weeks ----------
def _ms(v):
    """Epoch ms for a timezone-aware time; a local ISO string for floating times and all-day dates."""
    if isinstance(v, datetime):
        return int(v.timestamp() * 1000) if v.tzinfo else v.strftime("%Y-%m-%dT%H:%M:%S")
    return v.strftime("%Y-%m-%dT00:00:00")


@app.post("/v1/calendar")
async def calendar(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "Wrong Steward key."}, status_code=401)
    body = await request.json()
    url = str(body.get("url", "")).strip()
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


# ---------- status page (what you see on the Space's page) ----------
@app.get("/", response_class=HTMLResponse)
def status_page():
    h = health()
    docs = sorted({c["source"] for c in CHUNKS})
    status = ("✅ Ready. Connect Steward with this Space's name and your STEWARD_KEY." if h["configured"]
              else "⚠️ Add the <b>HF_TOKEN</b> and <b>STEWARD_KEY</b> secrets in Settings → Variables and secrets, then restart the Space.")
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;")
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steward</title><style>body{{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#18201d;background:#f3f5f2}}
@media (prefers-color-scheme:dark){{body{{color:#e6ece9;background:#121715}}}}</style></head><body>
<h1>🧭 Steward's AI server</h1><p><b>Status:</b> {status}</p>
<p><b>Models, in order:</b> {esc(", ".join(MODELS))}</p>
<p><b>Sync saves to:</b> {esc(h["sync"])}{(" · ⚠️ " + esc(STORE["error"])) if STORE["error"] else ""}</p>
<p><b>Documents in docs/:</b> {esc(", ".join(docs)) if docs else "none yet. Upload .txt, .md or .pdf files to the docs folder."}</p>
</body></html>"""


# ZeroGPU hardware refuses to start an app without at least one @spaces.GPU function. This server
# never needs a GPU (the models run on Hugging Face's inference servers), so register a no-op one.
try:
    import spaces

    @spaces.GPU
    def _zerogpu_placeholder():
        return None
except Exception:
    pass

# Spaces run `gradio app.py`, which launches the object named `demo`.
demo = app

if __name__ == "__main__":
    demo.launch(ssr_mode=False)
