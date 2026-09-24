# Steward

A local-first planner (tasks, calendar, projects, notes, auto-scheduling) with an on-device AI assistant that gets to know you. It's built on Kin Planner and the Kin Studio engine.

- **No backend, no API key.** Your planner, chats, and memories are stored only in your browser.
- **Assistant:** runs Qwen2.5 1.5B in your browser via [Transformers.js](https://huggingface.co/docs/transformers.js). If a device can't run it, the assistant switches to Qwen2.5 0.5B on its own.
- **Grows with you:** after each chat, Steward saves lasting facts about you, such as your work, routines, goals, and preferences. It also notices patterns in how you use the planner: how your estimates compare to actual time, your best time of day, and whether deadlines slip. Both go into every answer. To view, edit, delete, back up, or restore what it knows, open **Assistant → What I know**. You can also say "remember that …" to teach it something directly. The model itself never changes. The learning is this editable memory.
- **Password lock:** the published site is encrypted (AES-256-GCM, with the key derived from your password via PBKDF2-SHA256, 600k iterations). The password is not stored in any file.

## Hugging Face (optional, recommended)

On the Assistant screen, paste a Hugging Face access token (huggingface.co → Settings → Access Tokens → **Read**). Steward then answers with large hosted models: Qwen2.5 72B, falling back to Llama 3.3 70B or Qwen2.5 7B. The replies are fast on any device. The token is saved only in that browser, is sent only to Hugging Face, and is never committed or published. If Hugging Face is unreachable or your free allowance runs out, Steward switches to the on-device model. **Private mode** keeps every chat on the device.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The planner app (React + htm, no build step) |
| `kin-engine.js` | In-browser inference engine from Kin Studio |
| `assistant.js` | Assistant, memory, and pattern learning |
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
