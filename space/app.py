"""Steward's own Hugging Face Space.

A small server between the Steward app and Hugging Face:
- keeps the Hugging Face token here, as a Space secret, so it never reaches a browser
- only answers requests that carry the STEWARD_KEY secret
- adds the most relevant passages from the files in docs/ to each chat
- streams replies from a large hosted model, trying the next model if one is unavailable

Space secrets: HF_TOKEN (fine-grained, "Make calls to Inference Providers"), STEWARD_KEY (any long passphrase).
Optional variables: MODELS (comma-separated model ids), ALLOWED_ORIGINS (comma-separated).
"""
import json
import os
import re
import secrets
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

HF_TOKEN = os.environ.get("HF_TOKEN", "")
STEWARD_KEY = os.environ.get("STEWARD_KEY", "")
MODELS = [m.strip() for m in os.environ.get(
    "MODELS", "Qwen/Qwen2.5-72B-Instruct,meta-llama/Llama-3.3-70B-Instruct,Qwen/Qwen2.5-7B-Instruct").split(",") if m.strip()]
ORIGINS = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS", "https://jpolsley.github.io,http://localhost:8000,http://localhost:8123").split(",") if o.strip()]
ROUTER = os.environ.get("HF_ROUTER", "https://router.huggingface.co/v1/chat/completions")
DOCS_DIR = Path(__file__).parent / "docs"

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"], expose_headers=["X-Steward-Model"])


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
                chunks.append({"source": path.name, "text": piece, "terms": _terms(piece)})
    print(f"Loaded {len(chunks)} passages from docs/")
    return chunks


STOP = set("the and for are but not you your with this that have from was were will what when where which who how can our they them their about into than then just also more".split())


def _terms(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9']{3,}", text.lower()) if w not in STOP}


CHUNKS = _load_chunks()


def relevant_passages(query: str, limit: int = 4):
    q = _terms(query)
    if not q or not CHUNKS:
        return []
    scored = sorted(((len(q & c["terms"]), c) for c in CHUNKS), key=lambda x: -x[0])
    return [c for score, c in scored[:limit] if score >= 2]


# ---------- API ----------
def _authorized(request: Request) -> bool:
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    return bool(STEWARD_KEY) and secrets.compare_digest(given, STEWARD_KEY)


@app.get("/")
def health():
    return {"ok": True, "configured": bool(HF_TOKEN and STEWARD_KEY), "documents": len({c["source"] for c in CHUNKS}), "models": MODELS}


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

    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    passages = relevant_passages(str(last_user))
    if passages:
        docs = "\n\n".join(f"[{p['source']}] {p['text']}" for p in passages)
        note = "\n\nRelevant passages from the user's documents (cite the file name when you use them):\n" + docs
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
