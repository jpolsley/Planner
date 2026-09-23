# Kin Planner

A local-first planner (tasks, calendar, projects, notes, auto-scheduling) with **Kin AI** — the on-device assistant from Kin Studio — built in.

- **No backend, no API key.** Everything is saved in your browser's localStorage.
- **Assistant tab:** loads a small language model (SmolLM2 135M or Qwen2.5 0.5B) through [Transformers.js](https://huggingface.co/docs/transformers.js) and runs it in your browser. Kin sees a snapshot of your open tasks, meetings, and today's schedule. Any bulleted task it suggests has an **+ Add** button that sends it through the planner's command bar (e.g. "Call Sam fri 30m").

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The Kin Planner app (React + htm, no build step) |
| `kin-engine.js` | Kin Studio's inference engine (downloads the runtime and model on "Load") |
| `assistant.js` | The Assistant view that connects the planner to the engine |

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It needs to be served over http(s); opening the file directly may block the model download.

## Publish with GitHub Pages

The workflow in `.github/workflows/pages.yml` deploys the site whenever `main` changes. To turn it on, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The app will then be at `https://<your-username>.github.io/Planner/`.

## Notes

- The first model load downloads about 140 MB (Pocket) or 480 MB (Standard) from Hugging Face. After that the browser caches it.
- Small models make mistakes, so check suggestions before you add them.
- Model licenses: [SmolLM2](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct), [Qwen2.5](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct).
