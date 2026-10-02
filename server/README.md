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

## One-click Steward app (Mac)
`launch-steward.sh` starts Ollama and the server if they're not running, then opens Steward in your browser. To turn it into a **Steward** app you can click, run this once in Terminal:
```
osacompile -o ~/Applications/Steward.app -e 'if (do shell script "test -d /Volumes/AIRDRIVE/Steward/server && echo yes || echo no") is "no" then' -e 'display dialog "Plug in AIRDRIVE, then open Steward again." buttons {"OK"} default button "OK" with title "Steward"' -e 'else' -e 'do shell script "/bin/bash /Volumes/AIRDRIVE/Steward/server/launch-steward.sh"' -e 'end if'
```
If your Steward folder isn't on a drive called AIRDRIVE, change the two paths in that command. Server output is saved to `server.log`.

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
- `docs/`: the documents Diana reads (`.txt`, `.md` or `.pdf`). Add or remove them in Steward under **Diana → What I know → Add documents**, or from a project's **Related** section. They're used right away. You can also copy files into this folder yourself and restart the server.
- `data/steward.json`: your synced planner.
- `data/backups/`: one copy per day, and the last 14 days are kept.

## Work calendar (Outlook, read-only)
If Power Automate writes your work calendar to OneDrive as `diana-calendar.json` and shares it with a view-only link:
1. Open `~/Steward/server/steward.env` in TextEdit and add a line: `DIANA_WORK_CALENDAR_FEED_URL=` followed by the link.
2. Restart the server (click the Steward app after stopping it).
3. In Steward, go to **Settings → Calendars** and press **Add** next to **Work calendar**.

The server reads the feed (at most every 20 minutes) and keeps the last good copy if a read fails. The link never leaves the server. Steward plans around these meetings and Diana can see them; it never writes to your work calendar. Cancelled meetings and events marked *Free* are skipped. Private events show with their real titles; set `DIANA_WORK_CALENDAR_HIDE_PRIVATE=1` to show them only as "Private appointment".

## Work email (Outlook, read-only)
If Power Automate writes Inbox + Sent previews to OneDrive as `diana-email.json` with a view-only link, add `DIANA_WORK_EMAIL_FEED_URL=` followed by that link to `steward.env` and restart. The server groups messages into conversations, works out who spoke last and whether you replied, how long someone has been waiting, internal vs external (`DIANA_WORK_EMAIL_DOMAINS`, default salvationarmy.org), and automated mail vs a person. Diana uses that to tell you who is waiting on you and to draft replies for you to copy. She can't send email. The snapshot is cached in `data/work-email.json` (readable only by your account) and the last good copy is kept if a read fails.

## Updating the server
When Steward gets a new server feature, run this once in Terminal. It downloads the new server file and stops the old server:
```
curl -fsSL -o ~/Steward/server/steward_server.py https://raw.githubusercontent.com/ministryAI/Planner/main/server/steward_server.py && lsof -ti tcp:8787 | xargs kill
```
Then click the Steward app to start it again.

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
