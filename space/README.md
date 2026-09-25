---
title: Steward
emoji: 🧭
colorFrom: green
colorTo: indigo
sdk: gradio
sdk_version: 6.28.0
python_version: '3.12'
app_file: app.py
pinned: false
---

# Steward's AI server

This is the private backend for the Steward planner. It keeps the Hugging Face token on the server, adds passages from the files in `docs/` to each chat, and streams replies from a large hosted model.

**Secrets** (Settings → Variables and secrets):
- `HF_TOKEN`: a fine-grained Hugging Face token with only "Make calls to Inference Providers" ticked
- `STEWARD_KEY`: a long passphrase. Enter the same one in Steward.
- For sync: `HF_WRITE_TOKEN`, a fine-grained token with **write** access to your repos. It's used to save your planner to a private dataset called `steward-data`. Instead of adding this, you can give `HF_TOKEN` write access too.

**Optional variable:**
- `MODELS`: a comma-separated list of model ids, tried in order
- `STEWARD_DATA`: the dataset used for sync (default `<you>/steward-data`)

Add `.txt`, `.md` or `.pdf` files to `docs/`, and Steward will use them in its answers.
