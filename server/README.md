# Steward server (runs on your computer, no Hugging Face)

This small server is Steward's engine. It runs a local model through **Ollama** (by default **Qwen3 32B**), keeps your planner in sync across devices by saving it to a file on this computer, reads your calendar links, and uses your documents in answers.

**Computer:** Qwen3 32B needs about 20 GB for the model, plus room to work. Use at least 32 GB of memory (48 GB or more is better), or a graphics card with 24 GB. On a smaller computer, set `MODEL=qwen3:14b` in `steward.env`.

## 1. Install
1. Install **Ollama** from https://ollama.com and open it once.
2. Install **Python 3.10+** from https://python.org (Macs usually have it already).
3. Download this `server` folder, or the whole repository, onto the computer.

## 2. Start it
- **Mac / Linux:** double-click `start.command`, or run `./start.command` in Terminal.
- **Windows:** double-click `start.bat`.

The first start does three things:
- it creates `steward.env` with a new **Steward key** and prints the key, so copy it;
- it downloads Qwen3 32B (about 20 GB, one time);
- it starts the server at **http://localhost:8787**. Open that address to see the server's status.

Keep the window open while you use Steward. Closing the window stops the server.

## 3. Connect Steward
In Steward, open **Assistant**. Enter **http://localhost:8787** and your Steward key, then press **Connect**. The planner on that device uploads to the server. Every other device you connect gets the same planner.

## 4. Your phone (optional)
Your phone can't reach "localhost". It needs a private, secure link to this computer:
1. Install **Tailscale** (free) on the computer and the phone, and sign in to both with the same account.
2. On the computer, run: `tailscale serve --bg 8787`
3. It prints an address like `https://your-computer.tailnet-name.ts.net`. Enter that in Steward on your phone, with the same key.

Only your own devices can reach that address. The phone only has Steward's AI while this computer is on and awake.

## Your files
All of these live in `~/Steward` (change it with `STEWARD_HOME`):
- `docs/`: put `.txt`, `.md` or `.pdf` files here, then restart the server. Steward uses them in answers.
- `data/steward.json`: your synced planner.
- `data/backups/`: one copy per day, and the last 14 days are kept.

## Settings (`steward.env`)
| Setting | Default | |
|---|---|---|
| `STEWARD_KEY` | (made for you) | The passphrase Steward uses to connect |
| `MODEL` | `qwen3:32b` | Any Ollama model. Add fallbacks after a comma: `qwen3:32b,qwen3:14b` |
| `STEWARD_HOME` | `~/Steward` | Where docs and data live |
| `PORT` | `8787` | |
| `LLM_URL` | Ollama's local address | Any OpenAI-compatible chat endpoint |

## Leaving Hugging Face
1. Start this server and connect Steward on your main device first. Your current planner uploads here.
2. Connect your other devices to this server instead of the Space.
3. Delete the Space and its `steward-data` dataset on Hugging Face, and revoke the tokens you made for them.

Two things still download files from Hugging Face's website once, and then they're cached: **Private mode** (the small in-browser model) and the **meeting recorder's** speech model. Neither sends your data anywhere.
