---
title: Steward
emoji: 🧭
colorFrom: green
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Steward's AI server

This is the private backend for the Steward planner. It keeps the Hugging Face token on the server, adds passages from the files in `docs/` to each chat, and streams replies from a large hosted model.

**Secrets** (Settings → Variables and secrets):
- `HF_TOKEN`: a fine-grained Hugging Face token with only "Make calls to Inference Providers" ticked
- `STEWARD_KEY`: a long passphrase. Enter the same one in Steward.

**Optional variables:**
- `MODELS`: a comma-separated list of model ids, tried in order
- `ALLOWED_ORIGINS`: the sites allowed to call this Space

Add `.txt`, `.md` or `.pdf` files to `docs/`, and Steward will use them in its answers.
