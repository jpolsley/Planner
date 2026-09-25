# Steward

A local-first planner (tasks, calendar, projects, notes, auto-scheduling) with an on-device AI assistant that gets to know you. It's built on Kin Planner and the Kin Studio engine.

- **No backend, no API key.** Your planner, chats, and memories are stored only in your browser.
- **Assistant:** runs Qwen2.5 1.5B in your browser via [Transformers.js](https://huggingface.co/docs/transformers.js). If a device can't run it, the assistant switches to Qwen2.5 0.5B on its own.
- **Grows with you:** after each chat, Steward saves lasting facts about you, such as your work, routines, goals, and preferences. It also notices patterns in how you use the planner: how your estimates compare to actual time, your best time of day, and whether deadlines slip. Both go into every answer. To view, edit, delete, back up, or restore what it knows, open **Assistant → What I know**. You can also say "remember that …" to teach it something directly. The model itself never changes. The learning is this editable memory.
- **Boards:** Tasks and each project have a List and a Board view. Group the board by status, priority, project, or stage. Drag cards between columns. On a phone, hold a card for a moment and then drag it.
- **Checklists and repeats:** tasks can have steps (Steward can draft them with **Break it down**). They can also repeat, for example "water the plants every monday". Finishing a repeating task adds the next one.
- **Sync across devices:** with your Space connected, the planner and Steward's memory sync between your phone and computer through a private Hugging Face dataset (`<you>/steward-data`). If two devices change things at once, the changes are merged task by task. The Space's `HF_TOKEN` needs write access, or you can add a separate `HF_WRITE_TOKEN` secret.
- **Calendars:** paste a calendar's secret `.ics` address in Settings → Calendars (Google, Outlook or iCloud). Steward schedules around those meetings and refreshes them every 30 minutes.
- **Focus timer:** start a timer on any task. The time you track counts against its estimate and teaches Steward how long things really take.
- **Daily plan, wrap-up and weekly review:** these cards show on Today in the morning, at the end of the day, and at the end of the week. Steward can talk the plan through with you and write your weekly review, which is saved to Notes.
- **Steward can make changes:** ask in chat ("move my admin tasks to Friday"). Steward lists the changes, and nothing happens until you press Apply. Undo works as usual.
- **Password lock:** the published site is encrypted (AES-256-GCM, with the key derived from your password via PBKDF2-SHA256, 600k iterations). The password is not stored in any file.

## Your own AI server on Hugging Face (recommended)

The `space/` folder holds a small server that runs as your own Hugging Face **Space**. It keeps your Hugging Face token on the server, searches your documents, and answers with large models: Qwen2.5 72B, falling back to Llama 3.3 70B or Qwen2.5 7B. Steward connects to it with a key only you know. If the Space can't be reached, Steward switches to the on-device model. **Private mode** keeps every chat on the device.

See `space/README.md` for the Space's settings. To add documents, upload `.txt`, `.md` or `.pdf` files to the Space's `docs/` folder.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The planner app (React + htm, no build step) |
| `kin-engine.js` | In-browser inference engine from Kin Studio |
| `assistant.js` | Assistant, memory, and pattern learning |
| `sync.js` | Sync and calendar links through your Space |
| `tools/lock.mjs`, `tools/gate.html` | Build the password-locked site into `dist/` |

## Publish on GitHub Pages with a password

1. **Settings → Secrets and variables → Actions → New repository secret.** Name it `STEWARD_PASSWORD` and give it a value of at least 8 characters.
2. **Settings → Pages → Build and deployment → Source:** choose **GitHub Actions**.
3. Push to `main`, or run the "Deploy to GitHub Pages" workflow by hand. If the secret is missing, the build fails, so the site is never published unlocked.

To change the password, update the secret and re-run the workflow. Devices that chose "Stay unlocked" will be asked for the new password.

**What the password protects:** free GitHub Pages requires a public repository, so anyone can read this source code. That's fine, because it is only the app. Your personal data (tasks, chats, memories) is never in the repo. It lives only in your browser. The password stops other people from using your site, and the published page contains only encrypted data. Use a strong password: anyone can download the encrypted page and try to guess it offline.

## Run locally (unlocked)

```sh
python3 -m http.server 8000   # open http://localhost:8000
```

To test the locked build locally: `STEWARD_PASSWORD='something-long' node tools/lock.mjs`, then open `http://localhost:8000/dist/`.

## Notes

- The first load downloads about 1.1 GB from Hugging Face. After that the browser caches it. Chrome or Edge with a GPU (WebGPU) is much faster than CPU.
- Data is stored per browser and per device. Use Settings → Backup and "Back up memory" to move it.
- Model licenses: [Qwen2.5 1.5B](https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct), [Qwen2.5 0.5B](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct).
