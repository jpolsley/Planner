/* Steward Assistant — on-device AI for the planner, powered by the Kin Studio engine (kin-engine.js).
 * The model downloads once from Hugging Face, is cached by the browser, and runs locally.
 * Steward "grows" through memory: facts it learns about you in chat plus patterns from how you use the planner.
 * The model's weights never change; what it knows about you lives in this browser and can be edited. */
const KIN_MODELS = Object.freeze({
  main: { key: 'main', name: 'Qwen2.5 1.5B', repo: 'onnx-community/Qwen2.5-1.5B-Instruct', dtype: 'q4', dtypes: { webgpu: 'q4f16' }, context: 4096, size: '~1.1 GB' },
  // Only used if this device can't run the main model.
  fallback: { key: 'fallback', name: 'Qwen2.5 0.5B', repo: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q4', dtypes: { webgpu: 'q4f16' }, context: 4096, size: '~480 MB' },
});
/* Hugging Face-hosted models via the user's own Steward Space (see space/). The Space holds the
 * Hugging Face token; this browser only stores the Space address and its Steward key. */
const KIN_CLOUD_MODELS = [
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B' },
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' },
  { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5 7B' },
];
const KIN_CLOUD_KEY = 'kin.planner.cloud.v1';
/* "qwen3:8b" → "Qwen3 8B", "Qwen/Qwen2.5-72B-Instruct" → "Qwen2.5 72B": the name shown is the model the server really runs. */
const kinModelName = (id) => { const k = KIN_CLOUD_MODELS.find((x) => x.id === id); if (k) return k.name; const t = String(id || '').split('/').pop().replace(/-instruct$/i, ''); const m = t.match(/^([a-z][\w.]*?)[:\-](\d+(?:\.\d+)?b)\b/i); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2].toUpperCase() : t; };
const KIN_SPACE_KEY = 'steward.space.v1';
try { localStorage.removeItem('steward.hf.token'); } catch (e) {} // tokens now live only in the Space
const kinSpace = () => kinLoad(KIN_SPACE_KEY, null);
const kinCloudAvailable = () => { const sp = kinSpace(); return !!(sp && sp.url && sp.key); };
/* Accepts "user/space", huggingface.co/spaces/user/space, or the direct *.hf.space address. */
function kinSpaceUrl(input) {
  const t = String(input).trim().replace(/\/+$/, '');
  // Your own Steward server: http://localhost:8787, http://127.0.0.1:8787, or an https address (e.g. Tailscale Serve).
  const own = t.match(/^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?|https:\/\/[a-z0-9.-]+(?::\d+)?)$/i);
  if (own && !/huggingface\.co$/i.test(own[1])) return own[1].toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(t)) return 'http://' + t.toLowerCase();
  if (/^https:\/\/[a-z0-9-]+\.hf\.space$/i.test(t)) return t.toLowerCase();
  const m = t.match(/^(?:https?:\/\/)?(?:huggingface\.co\/spaces\/)?([\w.-]+)\/([\w.-]+)$/i);
  return m ? 'https://' + (m[1] + '-' + m[2]).toLowerCase().replace(/[._]/g, '-') + '.hf.space' : null;
}
const KIN_CHAT_KEY = 'kin.planner.chat.v1';
const KIN_COMPACT_KEY = 'steward.chat.compact.v1';
const KIN_MEM_KEY = 'kin.planner.memory.v1';
const KIN_PREF_KEY = 'kin.planner.ai.v1';
const KIN_BASE = 'You are Diana (D.I.A.N.A.: Digital Intelligence for Adaptive Navigation & Assistance), a thoughtful personal assistant and thinking partner who lives inside the user\'s planner, which is called Steward. You know the user and get to know them better over time. '
  + 'Talk like a warm, perceptive person in a text conversation: plain sentences and short paragraphs. Never use markdown: no headings, no bold or italics, no numbered or bulleted lists, no tables. If a few items truly need listing, weave them into a sentence. Keep most replies to a few short paragraphs. '
  + 'Be like a sharp, caring colleague who has their back, not a therapist. When the user first shares something about themselves or their situation, show you understood it in a sentence or two (in your own words, never by repeating theirs back) and, only if you truly need it, ask one question. '
  + 'Once you have the gist, which is usually by the second or third message on a topic, move the conversation forward: say plainly what you think is really going on, and offer one or two concrete, practical ideas they could try, then ask if they want help with one. Do not keep asking how things made them feel, and do not end every reply with a question. Avoid therapy phrases like "I wonder", "that must be hard", "it sounds like", "it\'s important to feel seen". Your job is not just to understand the user but to turn understanding into progress: once you understand enough to help, help. Before asking a question, be sure its answer would change what you recommend. '
  + 'Never summarize their documents at them unprompted. When they ask a question, answer it directly, using what you know about them, their documents and their planner. '
  + 'Only suggest tasks when the user asks for tasks or a plan. Then end your reply with a line "Suggested tasks:" followed by at most 5 lines starting with "- ", each with a duration like 30m and a day if relevant (this is the one place a list is allowed). '
  + 'Use the facts, documents, and planner snapshot provided; mention a document by name when you draw on it; never invent tasks, meetings, documents, or facts about the user.'
  + '\n\nYou can change the planner, but only when the user asks you to (e.g. "move my admin tasks to Friday", "mark the venue done", "add a meeting with Sam tomorrow at 2"). Then say briefly what you will change and end the reply with a block exactly like:\n```actions\n[{"op":"update","task":"T3","due":"2026-10-02"}]\n```\n'
  + 'Ops: {"op":"project","name":"...","desc":"what it is and what done looks like","due":"YYYY-MM-DD","stages":["Stage 1","Stage 2"]} (a new project; put it before any tasks added to it); {"op":"add","title":"...","minutes":30,"due":"YYYY-MM-DD or YYYY-MM-DDTHH:MM","priority":"asap|high|med|low","project":"project name","stage":"stage name"}; {"op":"update","task":"T#","title","minutes","due","start":"YYYY-MM-DD (don\'t start before)","priority","status":"todo|doing|blocked"} (only the fields that change; "due":null clears it); {"op":"done","task":"T#"}; {"op":"delete","task":"T#"}; {"op":"meeting","title":"...","start":"YYYY-MM-DDTHH:MM","minutes":30}; {"op":"move_meeting","meeting":"M#","start":"YYYY-MM-DDTHH:MM"}. '
  + 'Use only the T# and M# references from the planner snapshot. The user reviews and confirms every change, so never claim it is already done. If you say you will add or change anything, the actions block is required; if no op can do it, say so plainly instead. Never include an actions block when the user did not ask for a change.';

const kinLoad = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const kinSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------- memory: what Steward has learned about you ---------- */
const kinMem = {
  items: kinLoad(KIN_MEM_KEY, []), gone: kinLoad(KIN_MEM_KEY + '.gone', {}), subs: new Set(),
  commit(items) { this.items = items.slice(0, 300); kinSave(KIN_MEM_KEY, this.items); this.subs.forEach((f) => f()); if (typeof kinMemChanged === 'function') kinMemChanged(); },
  /* Replaces memory with a synced copy, without counting it as a local edit. */
  replace(items, gone) { this.items = items.slice(0, 300); this.gone = gone || {}; kinSave(KIN_MEM_KEY, this.items); kinSave(KIN_MEM_KEY + '.gone', this.gone); this.subs.forEach((f) => f()); },
  add(text, source) {
    text = String(text).trim().replace(/\s+/g, ' ').slice(0, 200);
    if (text.length < 4 || this.items.some((m) => kinSimilar(m.text, text))) return null;
    const m = { id: uid(), text, source, created: Date.now() };
    this.commit([m, ...this.items]);
    return m;
  },
  update(id, text) { this.commit(this.items.map((m) => (m.id === id ? { ...m, text, upd: Date.now() } : m))); },
  remove(id) { this.gone = { ...this.gone, [id]: Date.now() }; kinSave(KIN_MEM_KEY + '.gone', this.gone); this.commit(this.items.filter((m) => m.id !== id)); },
};
const kinTerms = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9']{3,}/g) || []);
function kinSimilar(a, b) {
  const x = kinTerms(a), y = kinTerms(b); if (!x.size || !y.size) return a.toLowerCase() === b.toLowerCase();
  let n = 0; x.forEach((t) => { if (y.has(t)) n++; });
  return n / Math.min(x.size, y.size) >= 0.75;
}
/* The facts most related to the current message, topped up with the newest ones. */
function kinRecall(query, limit = 14) {
  const q = kinTerms(query);
  const scored = kinMem.items.map((m, i) => { let s = 0; kinTerms(m.text).forEach((t) => { if (q.has(t)) s++; }); return { m, s, i }; });
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored.slice(0, limit).map((x) => x.m);
}

/* ---------- patterns: what Steward notices from how you use the planner ---------- */
function learnedPatterns(state) {
  const done = state.tasks.filter((t) => t.status === 'done' && t.completed);
  if (done.length < 5) return [];
  const out = [];
  const timed = done.filter((t) => t.spent > 0 && t.duration > 0).map((t) => t.spent / t.duration).sort((a, b) => a - b);
  if (timed.length >= 4) {
    const r = timed[Math.floor(timed.length / 2)];
    if (r > 1.15) out.push('Tasks usually take you about ' + Math.round((r - 1) * 100) + '% longer than you estimate.');
    else if (r < 0.85) out.push('You usually finish tasks about ' + Math.round((1 - r) * 100) + '% faster than you estimate.');
    else out.push('Your time estimates are usually accurate.');
  }
  const parts = { morning: 0, afternoon: 0, evening: 0 };
  const days = Array(7).fill(0);
  done.forEach((t) => { const d = new Date(t.completed), h = d.getHours(); parts[h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening']++; days[d.getDay()]++; });
  const best = Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  if (best[1] / done.length >= 0.45) out.push('You get the most done in the ' + best[0] + '.');
  const top = days.indexOf(Math.max(...days));
  if (days[top] / done.length >= 0.3) out.push(WDL[top].charAt(0).toUpperCase() + WDL[top].slice(1) + ' is usually your most productive day.');
  const dl = done.filter((t) => t.deadline);
  if (dl.length >= 4) {
    const late = dl.filter((t) => t.completed > t.deadline).length / dl.length;
    if (late >= 0.3) out.push('About ' + Math.round(late * 100) + '% of your deadlines slip, so build in buffer.');
    else if (late === 0) out.push('You reliably finish before your deadlines.');
  }
  const pri = {}; done.forEach((t) => { pri[t.priority] = (pri[t.priority] || 0) + 1; });
  const openLow = state.tasks.filter((t) => t.status !== 'done' && t.priority === 'low' && Date.now() - (t.created || Date.now()) > 14 * DAY).length;
  if (openLow >= 3) out.push('Low-priority tasks tend to sit untouched for weeks.');
  return out;
}

/* ---------- engine: one per page, so switching views keeps the model loaded ---------- */
const kinAI = {
  engine: null, status: 'idle', model: null, device: null, progress: '', error: '', note: '', subs: new Set(),
  jobs: new Map(), queue: Promise.resolve(), generating: false,
  set(patch) { Object.assign(this, patch); this.subs.forEach((f) => f()); },
  cloudOff: false, abort: null,
  useCloud() {
    const i = Math.min(kinLoad(KIN_CLOUD_KEY, 0), KIN_CLOUD_MODELS.length - 1);
    const sp = kinSpace();
    const known = sp && sp.model ? kinModelName(sp.model) : null;
    this.set({ status: 'ready', device: 'cloud', model: { key: 'cloud', name: known || 'Your Steward server', cloud: i }, progress: '', error: '', note: '' });
    // Ask the server which model it actually runs (the first one in its MODEL list).
    if (sp && sp.url) fetch(sp.url + '/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => {
      const id = Array.isArray(h.models) ? h.models[0] : h.model;
      if (!id) { try { kinSave(KIN_SPACE_KEY, { ...kinSpace(), features: Array.isArray(h.features) ? h.features : [] }); } catch (e) {} return; }
      try { kinSave(KIN_SPACE_KEY, { ...kinSpace(), model: id, features: Array.isArray(h.features) ? h.features : [] }); } catch (e) {}
      if (this.device === 'cloud') this.set({ model: { ...(this.model || {}), key: 'cloud', name: kinModelName(id) } });
    }).catch(() => {});
  },
  async load(key) {
    if (!key && !kinLoad(KIN_PREF_KEY, {}).onDevice) { if (kinCloudAvailable()) this.useCloud(); return; }
    if (!key) {
      this.set({ status: 'loading', progress: 'Checking for a GPU…', error: '' });
      let gpu = false;
      try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) {}
      if (!gpu) this.set({ note: 'This browser isn’t giving Diana access to the GPU, so it’s using the lighter 0.5B model on the CPU, which is slower. For the full 1.5B model and much faster replies, use a current version of Chrome or Edge.' });
      key = gpu ? 'main' : 'fallback';
    }
    // Ask the browser not to evict the downloaded model when space is short.
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    if (this.engine) this.engine.terminate();
    this.jobs.forEach((j) => j.reject(new Error('Model reloaded'))); this.jobs.clear();
    const model = KIN_MODELS[key];
    this.set({ status: 'loading', model, progress: 'Starting…', error: '', note: key === 'main' ? '' : this.note });
    const engine = createKinEngine((d) => {
      if (engine !== this.engine) return;
      if (d.type === 'progress') {
        const x = d.detail || {};
        const pct = typeof x.progress === 'number' ? ' ' + Math.round(x.progress) + '%' : '';
        this.set({ progress: (x.file ? String(x.file).split('/').pop() : x.status || '') + pct });
      } else if (d.type === 'ready') this.set({ status: 'ready', device: d.device, progress: '' });
      else if (d.type === 'error' && d.phase === 'load') {
        const msg = /^\d+$/.test(String(d.message).trim()) ? 'the browser ran out of memory' : d.message;
        if (key === 'main') { this.set({ note: 'This device couldn’t run the 1.5B model (' + msg + '), so Diana is using the lighter 0.5B model.' }); this.load('fallback'); }
        else this.set({ status: 'error', error: 'Diana couldn’t start: ' + msg + (msg === d.message ? '.' : '. Close other tabs and press Load Diana to try again.') });
      } else if (d.type === 'fallback') this.set({ progress: d.text });
      const job = this.jobs.get(d.requestId);
      if (!job) return;
      if (d.type === 'chunk' && job.onChunk) job.onChunk(d.text);
      if (d.type === 'done') { this.jobs.delete(d.requestId); job.resolve(d.text); }
      if (d.type === 'error' && d.phase === 'generate') { this.jobs.delete(d.requestId); job.reject(Object.assign(new Error(d.message), { partial: d.partial })); }
    }, { thread: 'direct', attempt: 1 });
    this.engine = engine;
    engine.postMessage({ type: 'init', model, device: 'auto' });
  },
  unload() { if (this.engine) this.engine.terminate(); this.set({ engine: null, status: 'idle', model: null }); },
  /* Runs one generation at a time; later calls wait their turn. */
  ask({ messages, baseSystem, maxTokens = 320, temperature = 0.6, onChunk, docs = true }) {
    const local = () => new Promise((resolve, reject) => {
      if (this.status !== 'ready') { reject(new Error('The model is not loaded.')); return; }
      const requestId = uid();
      this.jobs.set(requestId, { resolve, reject, onChunk });
      this.set({ generating: true });
      this.engine.postMessage({ type: 'generate', requestId, messages, baseSystem: baseSystem || messages[0].content, maxTokens, temperature });
    });
    const run = async () => {
      this.set({ generating: true });
      try {
        if (this.device === 'cloud') {
          try { return await kinCloudChat({ messages, maxTokens, temperature, onChunk, docs }); }
          catch (e) { if (e.name === 'AbortError' || e.partial) throw e; throw new Error('Your Steward server: ' + e.message); }
        }
        return await local();
      } finally { this.set({ generating: false }); }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  },
  stop() { if (this.abort) this.abort.abort(); if (this.engine) this.engine.postMessage({ type: 'stop' }); },
  whenReady() {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.status === 'ready') { this.subs.delete(check); resolve(); }
        else if (this.status === 'error') { this.subs.delete(check); reject(new Error(this.error)); }
      };
      this.subs.add(check); check();
    });
  },
};

/* Streams a reply from Hugging Face's OpenAI-compatible router, moving down the model list if one isn't offered. */
async function kinCloudChat({ messages, maxTokens, temperature, onChunk, docs = true }) {
  const sp = kinSpace();
  const ctrl = new AbortController(); kinAI.abort = ctrl;
  let res;
  try {
    res = await fetch(sp.url + '/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature, use_docs: docs }),
    });
  } catch (e) { kinAI.abort = null; if (e.name === 'AbortError') throw e; throw new Error('couldn’t reach it. Is the computer on and the server running?'); }
  if (!res.ok) {
    kinAI.abort = null;
    let detail = ''; try { detail = (await res.json()).error || ''; } catch (e) {}
    throw new Error(res.status === 401 && /Steward key/.test(detail) ? 'the Steward key doesn’t match the server'
      : res.status === 401 ? 'the model provider rejected the request'
      : res.status === 402 ? 'the free monthly allowance is used up'
      : res.status === 500 && detail ? detail
      : 'error ' + res.status + (detail ? ': ' + detail.slice(0, 120) : ''));
  }
  const used = res.headers.get('X-Steward-Model');
  if (used) { const name = kinModelName(used); if (!kinAI.model || kinAI.model.name !== name) kinAI.set({ model: { key: 'cloud', name } }); }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, '').trim();
        if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
        try { const c = JSON.parse(data).choices?.[0]?.delta?.content; if (c) { text += c; onChunk && onChunk(c); } } catch (e) {}
      }
    }
  } catch (e) { if (e.name !== 'AbortError') throw Object.assign(new Error(e.message), { partial: text }); }
  finally { kinAI.abort = null; }
  return text;
}

/* Ask the model which lasting facts about the user a message reveals. */
async function kinLearnFrom(userText, reply) {
  const explicit = userText.match(/^\s*(?:please\s+)?remember(?: that)?\s+(.{4,200})$/i);
  if (explicit) { const m = kinMem.add(explicit[1].replace(/^i\b/i, 'You').replace(/\bmy\b/gi, 'your').replace(/\bi\b/g, 'you').replace(/\bI'm\b/g, 'you are'), 'you'); return m ? [m] : []; }
  if (userText.trim().split(/\s+/).length < 4) return [];
  const known = kinRecall(userText, 20).map((m) => '- ' + m.text).join('\n') || '(none)';
  const prompt = 'Read the user\'s message and list any NEW lasting facts about the user that would help plan their life: their role or work, routines, energy and schedule habits, goals, important people, likes and dislikes, constraints. Write each as a short sentence starting with "You", on its own line starting with "- ". Skip one-off requests, questions, and anything already known. If there is nothing new, write NONE.\n\nAlready known:\n' + known + '\n\nUser message:\n' + userText;
  const text = await kinAI.ask({ messages: [{ role: 'system', content: 'You extract facts. Output only the list or NONE.' }, { role: 'user', content: prompt }], maxTokens: 90, temperature: 0, docs: false });
  if (/^\s*none\b/i.test(text)) return [];
  return text.split('\n').map((l) => l.match(/^\s*[-*•]\s*(You\b.{3,180})$/i)).filter(Boolean)
    .filter((m) => !/\b(seeking|asking|asked|request|wants? (me |you )?to|would like (me |you )?to|trying to (add|create|make)|looking to)\b/i.test(m[1]))
    .map((m) => kinMem.add(m[1].replace(/\.?\s*$/, '.'), 'chat')).filter(Boolean).slice(0, 3);
}

/* The tasks and meetings the assistant can refer to as T1, T2… and M1, M2… */
function snapshotRefs(state, now) {
  const tasks = state.tasks.filter((t) => t.status !== 'done')
    .sort((a, b) => (PRI[a.priority] - PRI[b.priority]) || ((a.deadline || Infinity) - (b.deadline || Infinity))).slice(0, 40);
  const events = state.events.filter((e) => e.end > now && e.start < addDays(sod(now), 14)).sort((a, b) => a.start - b.start).slice(0, 20);
  return { tasks, events, map: { ...Object.fromEntries(tasks.map((t, i) => ['T' + (i + 1), t.id])), ...Object.fromEntries(events.map((e, i) => ['M' + (i + 1), e.id])) } };
}
const isoDay = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

function plannerSnapshot(state, plan, now) {
  const { tasks: open, events: evs } = snapshotRefs(state, now);
  const today = plan.blocks.filter((b) => sod(b.start) === sod(now)).slice(0, 10);
  const title = (id) => (state.tasks.find((t) => t.id === id) || {}).title || 'task';
  const proj = (t) => (state.projects.find((p) => p.id === t.projectId) || {}).name;
  const lines = ['Now: ' + fmtD(now) + ' ' + fmtT(now) + ' (' + isoDay(now) + ').'];
  lines.push('Open tasks: ' + (open.length ? open.map((t, i) => '[T' + (i + 1) + '] ' + t.title + ' (' + PRI_LABEL[t.priority] + ', ' + fmtDur(remainingMin(t)) + (t.deadline ? ', due ' + fmtD(t.deadline) + ' ' + isoDay(t.deadline) : '') + (t.status === 'doing' ? ', in progress' : t.status === 'blocked' ? ', blocked' : '') + (proj(t) ? ', project ' + proj(t) : '') + ((plan.info[t.id] || {}).first ? ', scheduled ' + fmtD(plan.info[t.id].first) + ' ' + fmtT(plan.info[t.id].first) : '') + ')').join('; ') : 'none') + '.');
  lines.push('Meetings next 14 days: ' + (evs.length ? evs.map((e, i) => '[M' + (i + 1) + '] ' + e.title + ' ' + fmtD(e.start) + ' ' + fmtT(e.start) + (e.src ? ' (from their calendar, read-only)' : '')).join('; ') : 'none') + '.');
  lines.push('Scheduled today: ' + (today.length ? today.map((b) => fmtT(b.start) + ' ' + title(b.taskId)).join('; ') : 'nothing') + '.');
  const active = state.projects.filter((p) => p.status !== 'done');
  if (active.length) lines.push('Projects: ' + active.map((p) => p.name).join('; ') + '.');
  return lines.join('\n');
}

function kinSystem(state, plan, userText) {
  const facts = kinRecall(userText).map((m) => '- ' + m.text);
  const pats = learnedPatterns(state).map((p) => '- ' + p);
  const past = typeof recallConvos === 'function' ? recallConvos(state, userText) : [];
  const pb = typeof findPlaybook === 'function' ? findPlaybook(state, userText) : null;
  return KIN_BASE
    + (past.length ? '\n\nFrom earlier conversations (use when relevant, mention the date):\n' + past.map((c) => '- ' + fmtD(c.at) + ', ' + c.topic + ': ' + c.points.join(' ')).join('\n') : '')
    + (pb ? '\n\nThe user\'s playbook "' + pb.title + '" (their own lessons from a similar project):\n' + pb.body.slice(0, 1500) : '')
    + (facts.length ? '\n\nWhat you know about the user:\n' + facts.join('\n') : '')
    + (pats.length ? '\n\nPatterns noticed from their planner:\n' + pats.join('\n') : '')
    + '\n\nPlanner snapshot:\n' + plannerSnapshot(state, plan, Date.now());
}

/* Diana writes plain text; if a model slips into markdown anyway, show it without the symbols. */
const kinPlain = (t) => String(t || '').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$|[.,!?])/g, '$1$2').replace(/^\s*---+\s*$/gm, '');

/* Pulls the ```actions block out of a reply. */
function chatActions(text) {
  const m = String(text).match(/```\s*actions\s*\n?([\s\S]*?)(```|$)/i) || String(text).match(/```\s*json\s*\n?(\[[\s\S]*?"op"[\s\S]*?\])\s*(```)/i);
  if (!m) return { clean: String(text), actions: [], partial: false };
  const clean = String(text).replace(m[0], '').trim();
  if (!m[2]) return { clean, actions: [], partial: true };
  try { const a = JSON.parse(m[1].trim().replace(/,\s*([}\]])/g, '$1')); return { clean, actions: (Array.isArray(a) ? a : [a]).filter((x) => x && x.op) }; }
  catch (e) { return { clean, actions: [], bad: true }; }
}
/* A separate, small request that asks only for the changes, as JSON. Small local models often say they'll make a
 * change but don't write the block; asked on its own with a short prompt, they do much better. */
const DIANA_OPS = KIN_BASE.slice(KIN_BASE.indexOf('Ops: '), KIN_BASE.indexOf('Use only the T# and M#'));
const DIANA_CHANGE_ASK = /\b(add|create|make|set up|setup|schedule|move|reschedule|mark|finish|delete|remove|put|rename|change|push|book)\b|\b(do it|go ahead|yes please|sounds good|just add)\b/i;
async function dianaExtractActions(history, reply, state, now) {
  const refs = snapshotRefs(state, now);
  const tasks = refs.tasks.map((t, i) => 'T' + (i + 1) + ' ' + t.title).join('\n');
  const meets = refs.events.map((e, i) => 'M' + (i + 1) + ' ' + e.title + ' ' + fmtD(e.start) + ' ' + fmtT(e.start)).join('\n');
  const convo = [...history.slice(-6), { role: 'assistant', content: reply }].map((m) => (m.role === 'user' ? 'User: ' : 'Diana: ') + String(m.content).replace(/```[\s\S]*?```/g, '').slice(0, 1200)).join('\n');
  const sys = 'You turn a planner conversation into planner changes. Output only a JSON array of change objects, or [] if the user has not asked for a change.';
  const user = 'Today is ' + isoDay(now) + ' (' + fmtD(now) + ').\nChange formats:\n' + DIANA_OPS + '\nProjects: ' + (state.projects.map((p) => p.name).join('; ') || 'none') + '\nOpen tasks:\n' + (tasks || 'none') + '\nMeetings:\n' + (meets || 'none')
    + '\n\nConversation:\n' + convo + '\n\nWhat changes did the user ask for (including details agreed earlier in the conversation)? Output only the JSON array.';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 500, temperature: 0, docs: false });
  const m = String(out).match(/\[[\s\S]*\]/);
  if (!m) return { actions: [], refs: refs.map };
  try { const a = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); return { actions: (Array.isArray(a) ? a : [a]).filter((x) => x && x.op).slice(0, 12), refs: refs.map }; }
  catch (e) { return { actions: [], refs: refs.map }; }
}

function describeAction(a, refs, state) {
  const task = (r) => state.tasks.find((t) => t.id === refs[r]);
  const ev = (r) => state.events.find((e) => e.id === refs[r]);
  const when = (v) => { const t = parseDue(v, state); return t ? fmtD(t) + (/T\d/.test(v) ? ' ' + fmtT(t) : '') : v; };
  const t = a.task && task(a.task);
  if (a.op === 'project') return 'Create project “' + a.name + '”' + (a.due ? ', due ' + when(a.due) : '') + (Array.isArray(a.stages) && a.stages.length ? ', stages: ' + a.stages.join(' → ') : '');
  if (a.op === 'add') return 'Add “' + a.title + '”' + (a.minutes ? ', ' + fmtDur(+a.minutes) : '') + (a.due ? ', due ' + when(a.due) : '') + (a.priority && a.priority !== 'med' ? ', ' + (PRI_LABEL[a.priority] || a.priority) : '') + (a.project ? ', in ' + a.project + (a.stage ? ' › ' + a.stage : '') : '');
  if (a.op === 'meeting') return 'Add meeting “' + a.title + '” ' + when(a.start) + (a.minutes ? ' for ' + fmtDur(+a.minutes) : '');
  if (a.op === 'move_meeting') { const e = a.meeting && ev(a.meeting); return e ? (e.src ? '✕ “' + e.title + '” is from your calendar; change it there' : 'Move “' + e.title + '” to ' + when(a.start)) : null; }
  if (!t) return null;
  if (a.op === 'done') return 'Mark “' + t.title + '” done';
  if (a.op === 'delete') return 'Delete “' + t.title + '”';
  if (a.op === 'update') {
    const parts = [];
    if (a.title) parts.push('rename to “' + a.title + '”');
    if ('due' in a) parts.push(a.due ? 'due ' + when(a.due) : 'no deadline');
    if (a.start) parts.push('start ' + when(a.start));
    if (a.minutes) parts.push(fmtDur(+a.minutes));
    if (a.priority) parts.push((PRI_LABEL[a.priority] || a.priority) + ' priority');
    if (a.status) parts.push(({ todo: 'to do', doing: 'in progress', blocked: 'blocked' })[a.status] || a.status);
    return parts.length ? 'Change “' + t.title + '”: ' + parts.join(', ') : null;
  }
  return null;
}
/* "2026-10-02" → end of that workday; "2026-10-02T14:00" → that time. */
function parseDue(v, state) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const day = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  if (m[4] != null) return atMin(day, +m[4] * 60 + +m[5]);
  return atMin(day, ((state.settings.hours[new Date(day).getDay()]) || [0, 1020])[1]);
}

function ActionCard({ x, state, A, patch }) {
  const acts = x.actions.map((a, i) => ({ a, i, text: describeAction(a, x.refs || {}, state) })).filter((r) => r.text);
  const [off, setOff] = useState({});
  if (!acts.length) return x.actions.length ? html`<div class="small muted" style=${{ marginTop: '6px' }}>Diana suggested changes, but they refer to tasks that no longer exist.</div>` : null;
  if (x.applied) return html`<div class="dprop-done">✓ ${x.applied}</div>`;
  const on = acts.filter((r) => !off[r.i] && !r.text.startsWith('✕'));
  const apply = () => {
    const list = on.map((r) => ({ ...r.a, task: r.a.task && x.refs[r.a.task], meeting: r.a.meeting && x.refs[r.a.meeting] }));
    A.applyActions(list, x.run, x.id);
    if (typeof stewardEvents === 'object') stewardEvents.record('proposal_decision', { entity: 'diana', actor: 'user', corr: x.run, proposal: x.id, data: { decision: list.length === acts.length ? 'applied' : 'partly_applied', applied: list.length, proposed: x.actions.length, skipped: acts.filter((r) => !on.includes(r)).map((r) => r.a) } });
    patch(x.id, () => ({ applied: 'Applied ' + list.length + ' change' + (list.length === 1 ? '' : 's') + '. Press Undo to reverse.' }));
  };
  const skip = () => { if (typeof stewardEvents === 'object') stewardEvents.record('proposal_decision', { entity: 'diana', actor: 'user', corr: x.run, proposal: x.id, data: { decision: 'dismissed', proposed: x.actions.length } }); patch(x.id, () => ({ applied: 'Dismissed.' })); };
  return html`<div class="dprop diana-surface diana-surface--proposal" role="group" aria-label="Proposed changes">
    <i class="diana-sheen" aria-hidden="true"></i>
    <div class="dprop-in">
      <div class="dprop-h"><${Icon} n="diana" cls="diana-mark" /><span class="diana-label" style=${{ color: 'var(--diana-muted)' }}>Proposed ${acts.length === 1 ? 'change' : 'plan'}</span><span class="n">${on.length} of ${acts.length} selected</span></div>
      <div class="dprop-list">${acts.map((r) => { const dis = r.text.startsWith('✕'); const isOn = !off[r.i] && !dis; return html`<label key=${r.i} class=${'dprop-item' + (isOn ? '' : ' off')}><input type="checkbox" disabled=${dis} checked=${isOn} onChange=${(e) => setOff({ ...off, [r.i]: !e.target.checked })} /><span>${r.text}</span></label>`; })}</div>
      <div class="dprop-foot"><span class="hint">Untick anything you don’t want. You can undo after.</span><button class="btn sm ghost" onClick=${skip}>Dismiss</button><button class="btn sm pri" disabled=${!on.length} onClick=${apply}>${on.length === acts.length ? (acts.length === 1 ? 'Apply change' : 'Apply plan') : 'Apply ' + on.length}</button></div>
    </div>
  </div>`;
}

/* Chat replies: only lines under a "Suggested tasks:" heading become + Add buttons. */
function chatTaskLines(text) {
  const m = String(text).split(/\n\s*\**suggested (?:next )?tasks?\**:?\**\s*\n/i);
  return m.length > 1 ? suggestionLines(m[m.length - 1]) : [];
}
const suggestionLines = (text) => text.split('\n').map((l) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,160})$/)).filter(Boolean).map((m) => m[1].replace(/\*\*/g, '').trim());

/* Load automatically on startup once the user has opted in. */
{
  const pf = kinLoad(KIN_PREF_KEY, {});
  if (pf.onDevice) { if (pf.autoLoad !== false) setTimeout(() => kinAI.status === 'idle' && kinAI.load(), 1500); }
  else if (kinCloudAvailable()) kinAI.useCloud();
}

/* ---------- Today bar: brain dump → tasks, and plain-language filtering ---------- */
const kinAIAvailable = () => kinCloudAvailable() || (kinLoad(KIN_PREF_KEY, {}).onDevice && kinAI.status === 'ready');
function kinBarIntent(text) {
  if (/^\s*(show|filter|find|which|what|list)\b/i.test(text)) return 'filter';
  const words = text.trim().split(/\s+/).length;
  // More than one thing ("laundry and clean the kitchen"), several lines, or a long ramble → let the AI split it.
  if (/\n|,|;|\band\b|\balso\b|\bthen\b|\bplus\b|&/i.test(text) || words > 8 || /^\s*(brain ?dump|dump)\b/i.test(text)) return 'dump';
  return 'command';
}
async function kinReady() {
  if (kinAI.status !== 'ready') kinAI.load();
  await kinAI.whenReady();
}
async function kinBrainDump(text, state) {
  await kinReady();
  const now = Date.now();
  const open = state.tasks.filter((t) => t.status !== 'done').map((t) => '- ' + t.title).slice(0, 40).join('\n') || '(none)';
  const facts = kinRecall(text, 8).map((m) => '- ' + m.text).join('\n');
  const sys = 'You turn a messy brain dump into clear, separate to-dos for a planner. Output ONLY task lines, one per line, each starting with "- ". '
    + 'Each line: a short title starting with a verb; then, when the dump implies them, a duration (e.g. 30m, 1h), a day or deadline (e.g. "by fri", "tomorrow", "oct 3"), and "high", "low" or "asap"; and for a recurring chore a repeat such as "every monday", "daily" or "monthly". '
    + 'For a meeting or call at a set time write it like "Call Sam fri 2pm". Every separate action is its own line: "do laundry and clean the kitchen" becomes "- Do laundry" and "- Clean the kitchen". Skip anything already in the existing list. No headings, numbering, or commentary.';
  const user = 'Today is ' + fmtD(now) + ' ' + fmtT(now) + '.\n' + (facts ? 'About the user:\n' + facts + '\n' : '') + 'Existing open tasks:\n' + open + '\n\nBrain dump:\n' + text;
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 500, temperature: 0.2 });
  return suggestionLines(out).map((l) => l.replace(/^\[.\]\s*/, '').replace(/\s*[.;]$/, '')).filter((l) => l.length > 2).slice(0, 25);
}
/* Drafts the concrete steps for one task, as a checklist. */
async function kinBreakdown(t, state) {
  await kinReady();
  const p = state.projects.find((x) => x.id === t.projectId);
  const have = (t.checklist || []).map((x) => '- ' + x.text).join('\n');
  const facts = kinRecall(t.title + ' ' + (t.desc || ''), 6).map((m) => '- ' + m.text).join('\n');
  const sys = 'You break one task into the small, concrete steps needed to finish it. Output ONLY 3 to 8 lines, each starting with "- ", each a short step starting with a verb, in the order they happen. No headings, numbering, times or commentary.';
  const user = (facts ? 'About the user:\n' + facts + '\n' : '') + 'Task: ' + t.title + (p ? '\nProject: ' + p.name + (p.desc ? ' (' + p.desc.slice(0, 300) + ')' : '') : '') + (t.desc ? '\nNotes: ' + t.desc.slice(0, 800) : '') + '\nEstimate: ' + fmtDur(t.duration || 30) + (have ? '\nSteps already listed (don’t repeat them):\n' + have : '');
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 260, temperature: 0.3, docs: false });
  const seen = new Set((t.checklist || []).map((x) => x.text.toLowerCase()));
  return suggestionLines(out).map((l) => l.replace(/^\[.\]\s*/, '').replace(/\s*[.;]$/, '')).filter((l) => l.length > 2 && !seen.has(l.toLowerCase())).slice(0, 8);
}
async function kinFilterTasks(text, state) {
  await kinReady();
  const now = Date.now();
  const open = state.tasks.filter((t) => t.status !== 'done').slice(0, 60);
  if (!open.length) return [];
  const list = open.map((t, i) => (i + 1) + '. ' + t.title + ' (' + PRI_LABEL[t.priority] + ', ' + fmtDur(remainingMin(t)) + (t.deadline ? ', due ' + relD(t.deadline, now) + (t.hard ? ' (hard)' : '') : '') + (t.status === 'doing' ? ', in progress' : '') + ((t.labels || []).length ? ', labels ' + t.labels.join('/') : '') + ((state.projects.find((p) => p.id === t.projectId) || {}).name ? ', project ' + state.projects.find((p) => p.id === t.projectId).name : '') + ')').join('\n');
  const sys = 'You filter a task list. Reply with ONLY the numbers of the matching tasks, comma-separated, most relevant first, or NONE.';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Today is ' + fmtD(now) + '.\nTasks:\n' + list + '\n\nRequest: ' + text }], baseSystem: sys, maxTokens: 80, temperature: 0.1, docs: false });
  if (/none/i.test(out) && !/\d/.test(out)) return [];
  const seen = new Set();
  return (out.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= open.length && !seen.has(n) && seen.add(n)).map((n) => open[n - 1].id);
}

/* ---------- AI project planning and meeting notes (same review screens as the built-in versions) ---------- */
function kinJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI didn’t return a plan. Try rewording the goal.');
  return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
}
async function kinDraftProject(goal, state) {
  await kinReady();
  const now = Date.now();
  const facts = kinRecall(goal, 8).map((m) => '- ' + m.text).join('\n');
  const pb = typeof findPlaybook === 'function' ? findPlaybook(state, goal) : null;
  const sys = 'You are a project planner.'
    + (pb ? ' The user has a playbook from running a similar project before. Follow its stages, realistic durations and lessons unless the goal clearly differs.' : '') + ' ' + ' Break the goal into 3-6 stages in order, each with 2-6 concrete tasks a single person can do. '
    + 'Estimate each task in minutes (15-480). Reply with ONLY JSON: {"name":"short project name","target":"YYYY-MM-DD or null",'
    + '"stages":[{"name":"stage name","tasks":[{"title":"verb-first task","minutes":60}]}],"assumptions":["..."],"question":"one question that would improve the plan"}';
  const user = 'Today is ' + new Date(now).toISOString().slice(0, 10) + ' (' + fmtD(now) + ').\n' + (facts ? 'About the user:\n' + facts + '\n' : '') + (pb ? 'Their playbook "' + pb.title + '":\n' + pb.body + '\n' : '') + 'Goal: ' + goal;
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 1100, temperature: 0.3 });
  const j = kinJSON(out);
  const stagesIn = (j.stages || []).filter((st) => st && st.name && (st.tasks || []).length).slice(0, 8);
  if (!stagesIn.length) throw new Error('The AI plan had no stages. Try describing the outcome in more detail.');
  const w = parseWhen(goal, now);
  const totalMin = stagesIn.reduce((a, st) => a + st.tasks.reduce((b, t) => b + (Math.min(480, Math.max(15, +t.minutes || 30))), 0), 0);
  const aiDate = /^\d{4}-\d{2}-\d{2}$/.test(j.target || '') ? fromDateInput(j.target, true) : null;
  const target = w.date != null ? atMin(w.date, 1020) : aiDate && aiDate > now + DAY ? aiDate : addDays(sod(now), Math.max(14, Math.ceil(totalMin / 60 / 2) * 2 + 7)) + 1020 * MIN;
  const span = target - now;
  let acc = 0;
  const stages = stagesIn.map((st, si) => ({
    name: String(st.name).slice(0, 60),
    tasks: st.tasks.slice(0, 10).map((t, ti) => {
      const dur = Math.round(Math.min(480, Math.max(15, +t.minutes || 30)) / 15) * 15;
      acc += dur;
      return { key: si + '.' + ti, title: String(t.title || 'Task').slice(0, 120), duration: dur, include: true, depStage: si > 0 ? String(stagesIn[si - 1].name).slice(0, 60) : null, deadline: sod(now + span * (acc / totalMin)) + 1020 * MIN };
    }),
  }));
  const assume = (j.assumptions || []).map(String).slice(0, 5);
  if (w.date == null && !aiDate) assume.unshift('No target date given, so I assumed ' + fmtD(target) + '.');
  if (pb) assume.unshift('Based on your playbook “' + pb.title + '”.');
  assume.push('Drafted by Diana. Deadlines are spread by effort; adjust anything before accepting.');
  return { goal, name: String(j.name || goal).slice(0, 80), kind: 'AI plan', target, stages, assume, ask: j.question ? String(j.question) : null, dateGiven: w.date != null, usedPlaybook: pb ? pb.id : null };
}
async function kinExtractNote(note, state) {
  await kinReady();
  const now = Date.now();
  const sys = 'You read meeting notes and pull out what matters. Reply with ONLY JSON: {"summary":"2 sentences","decisions":["..."],'
    + '"myActions":["things the note-taker (me) must do, each written like \\"Email Sam the budget by fri 30m\\"; meetings with a time like \\"Call venue tue 2pm\\""],'
    + '"othersActions":[{"owner":"name","task":"what they will do"}]}. Use only what is in the notes.';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Today is ' + fmtD(now) + '.\nNotes titled "' + note.title + '":\n' + note.body.slice(0, 12000) }], baseSystem: sys, maxTokens: 900, temperature: 0.2 });
  const j = kinJSON(out);
  const actions = [], events = [];
  (j.myActions || []).map(String).forEach((line) => {
    const p = parseCommand(line, state, now);
    if (p.kind === 'event') events.push({ line: null, include: true, ...p });
    else actions.push({ line: null, include: true, ...p, kind: 'task' });
  });
  (j.othersActions || []).forEach((o) => { if (o && o.task) actions.push({ line: null, include: false, kind: 'task', title: String(o.task).charAt(0).toUpperCase() + String(o.task).slice(1), duration: 30, priority: 'med', deadline: parseCommand(String(o.task), state, now).deadline, owner: o.owner, note: 'Owned by ' + o.owner + '. Add it if you want to track it.' }); });
  return { summary: String(j.summary || 'Summary unavailable.'), decisions: (j.decisions || []).map((t) => ({ line: null, text: String(t) })), actions, events };
}

/* Opening Diana from a task or project: the context travels as data (type + id), not as words put in the
 * user's mouth. Diana gets the facts about it for each message until the user clears it. */
const DIANA_CTX_KEY = 'steward.diana.ctx.v1';
function openDiana(setView, context, question) {
  kinSave(DIANA_CTX_KEY, { ...context, at: Date.now(), question: question || null });
  setView('assistant');
}
function dianaContextInfo(c, state, plan) {
  if (!c) return null;
  const refs = {};
  if (c.type === 'project') {
    const p = state.projects.find((x) => x.id === c.id);
    if (!p) return null;
    return { label: 'Project: ' + p.name, chips: ['What’s missing from this project?', 'Is this still realistic?', 'What should happen next?'],
      block: 'ACTIVE CONTEXT: the user opened you from the page for the project "' + p.name + '". Unless they say otherwise, "this" means this project.\n' + (p.doneDef ? 'Done looks like: ' + p.doneDef.slice(0, 300) + '\n' : '') + agentTool('project_status', { name: p.name }, state, plan, refs).slice(0, 1800) };
  }
  if (c.type === 'task') {
    const t = state.tasks.find((x) => x.id === c.id);
    if (!t) return null;
    const inf = plan.info[t.id] || {};
    const facts = [agentTool('search_tasks', { query: t.title }, state, plan, refs).split('\n')[0],
      t.kind === 'decision' ? 'This is a decision the user needs to make.' : t.kind === 'waiting' ? 'The user is waiting on ' + (t.waitingOn || 'someone') + ' for this.' : '',
      inf.unscheduled ? 'It does not fit in their schedule: ' + (inf.reason || 'not enough open time before the horizon') + '.' : inf.first ? 'Scheduled ' + fmtD(inf.first) + ' ' + fmtT(inf.first) + ' to ' + fmtD(inf.end) + ' ' + fmtT(inf.end) + (inf.why && inf.why.length ? ' (earliest open time ' + inf.why.join(' and ') + ')' : '') + (inf.late ? ', which is after its deadline' : '') + '.' : '',
      (t.checklist || []).length ? 'Checklist: ' + t.checklist.map((x) => (x.done ? '[x] ' : '[ ] ') + x.text).join('; ') : '',
      t.desc ? 'Notes: ' + t.desc.slice(0, 600) : ''].filter(Boolean).join('\n');
    return { label: (t.kind === 'decision' ? 'Decision: ' : 'Task: ') + t.title, chips: t.kind === 'decision' ? ['Help me decide this', 'What do I need to know to decide?'] : ['Break this down', 'Why is this scheduled here?', 'Can I get this done sooner?'],
      block: 'ACTIVE CONTEXT: the user opened you from the task "' + t.title + '". Unless they say otherwise, "this" means this task.\n' + facts };
  }
  return null;
}

function AssistantView(ctx) {
  const { state, plan, runCommand, setToast, A, commit } = ctx;
  const [, force] = useState(0);
  const [menu, setMenu] = useState(false);
  const [jump, setJump] = useState(false);
  const fileRef = useRef();
  const [prefs, setPrefsRaw] = useState(() => ({ autoLoad: true, learn: true, ...kinLoad(KIN_PREF_KEY, {}) }));
  const [msgs, setMsgs] = useState(() => kinLoad(KIN_CHAT_KEY, []));
  const [input, setInput] = useState('');
  const [added, setAdded] = useState({});
  const [pendingText, setPending] = useState(null);
  const [actx, setActx] = useState(() => { const c = kinLoad(DIANA_CTX_KEY, null); return c && Date.now() - (c.at || 0) < 12 * 3600000 ? c : null; });
  const clearCtx = () => { setActx(null); try { localStorage.removeItem(DIANA_CTX_KEY); } catch (e) {} };
  const ci = dianaContextInfo(actx, state, plan);
  /* The conversation scrolls; the bar never moves. Follow new text while the user is near the bottom; if they've
   * scrolled up to reread, leave them there and offer a "Latest" button instead. */
  const scrollRef = useRef();
  const stick = useRef(true);
  const toBottom = (smooth) => { const el = scrollRef.current; if (!el) return; stick.current = true; setJump(false); el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); };
  const onScroll = () => { const el = scrollRef.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; stick.current = near; if (near && jump) setJump(false); };

  useEffect(() => { const f = () => force((n) => n + 1); kinAI.subs.add(f); kinMem.subs.add(f); return () => { kinAI.subs.delete(f); kinMem.subs.delete(f); }; }, []);
  useEffect(() => { kinSave(KIN_CHAT_KEY, msgs.filter((m) => !m.pending).slice(-60)); }, [msgs]);
  /* Past conversations: summarize what hasn't been summarized, after a quiet spell, on leaving, or before clearing. */
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const summarizing = useRef(false);
  const remember = async () => {
    const todo = msgsRef.current.filter((m) => !m.pending && !m.summarized && m.content);
    if (summarizing.current || todo.filter((m) => m.role === 'user').length < 2 || !(typeof kinAIAvailable === 'function' && kinAIAvailable()) || prefs.learn === false) return;
    summarizing.current = true;
    try {
      const c = await kinSummarizeChat(todo);
      if (c) { commit((s) => ({ ...s, convos: [c, ...(s.convos || [])].slice(0, 200) })); const prev = kinLoad(KIN_COMPACT_KEY, null); kinSave(KIN_COMPACT_KEY, { points: [...(prev ? prev.points : []), ...c.points].slice(-12) }); }
      const ids = new Set(todo.map((m) => m.id));
      setMsgs((m) => m.map((x) => (ids.has(x.id) ? { ...x, summarized: true } : x)));
      kinSave(KIN_CHAT_KEY, msgsRef.current.map((x) => (ids.has(x.id) ? { ...x, summarized: true } : x)).filter((m) => !m.pending).slice(-60));
    } catch (e) {} finally { summarizing.current = false; }
  };
  useEffect(() => { const t = setTimeout(remember, 3 * 60000); return () => clearTimeout(t); }, [msgs]);
  useEffect(() => () => { remember(); }, []);
  useLayoutEffect(() => { if (stick.current) { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; } else if (msgs.length) setJump(true); }, [msgs, pendingText]);
  useEffect(() => { toBottom(false); }, []);
  const setPrefs = (p) => setPrefsRaw((x) => { const n = { ...x, ...p }; kinSave(KIN_PREF_KEY, n); return n; });

  const ready = kinAI.status === 'ready', busy = kinAI.generating;
  const thinking = busy || msgs.some((m) => m.pending) || !!pendingText;
  const patch = (id, fn) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, ...fn(x) } : x)));
  const send = async (text) => {
    text = (text || input).trim();
    if (!text || busy) return;
    if (!ready && !prefs.onDevice && !kinCloudAvailable()) { setToast({ text: 'Connect your Steward server above first, or turn on Private mode', id: uid() }); return; }
    if (!ready) {
      // Keep the message and send it as soon as the model is ready.
      setPending(text); setInput('');
      if (kinAI.status !== 'loading') kinAI.load();
      return;
    }
    const id = uid();
    const mode = prefs.mode || 'ask';
    // Context compacting: recent messages go in full; older ones as the running summary of this chat.
    const compact = kinLoad(KIN_COMPACT_KEY, null);
    const refs = { ...snapshotRefs(state, Date.now()).map };
    const run = 'run-' + uid().slice(0, 10);
    const prior = msgs;
    stick.current = true; setJump(false);
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: text, at: Date.now() }, { id, role: 'assistant', content: '', pending: true, refs, run }]);
    setInput('');
    let reply = '';
    try {
      // Asked about email: look up who is waiting first, so a small model doesn't have to decide to.
      let mail = '';
      if (typeof agentEmailOn === 'function' && agentEmailOn() && /\b(e-?mails?|inbox|repl(y|ies|ied)|respond(ed)?|get back to|waiting on me|follow(ed)? up|owe)\b/i.test(text)) {
        patch(id, () => ({ steps: ['email_attention'] }));
        mail = await agentEmailTool('email_attention', {}, refs);
      }
      const base = kinSystem(state, plan, text) + (ci ? '\n\n' + ci.block : '') + (mail ? '\n\nWORK EMAIL (looked up by Steward for this message; read-only, you cannot send):\n' + mail : '')
        + (compact && compact.points.length ? '\n\nEarlier in this conversation:\n' + compact.points.map((p) => '- ' + p).join('\n') : '')
        + (mode === 'plan' ? '\n\nPLAN-ONLY MODE: the user has turned off changes. Never include an actions block; describe what you would change in words.' : '');
      // The guard and the lookups apply to this request only; the stored chat stays exactly as said.
      const { system, history, meta } = guardRequest({ msgs: prior, text, baseSystem: base, variant: guardVariant(), state, plan, refs });
      const r = await agentRun({ system, history, state, plan, refs, onStep: (steps) => patch(id, () => ({ steps: steps.map((x) => x.tool) })), onText: (t) => patch(id, () => ({ content: t })) });
      reply = r.text;
      const fakeBlock = /\[proposed changes\]/i.test(reply);
      let acts = mode === 'plan' ? [] : chatActions(reply).actions;
      // She said she'd change something, or the user asked for one, but no changes came back: ask separately, once.
      let repaired = null;
      const claimed = /\b(i['’]ll|i will|i['’]ve|i have|let me|i['’]m going to|i can)\s+(go ahead and\s+)?(add|create|set up|make|move|mark|schedule|update|put)\b/i.test(reply) || fakeBlock;
      if (mode !== 'plan' && !acts.length && (claimed || DIANA_CHANGE_ASK.test(text))) {
        try {
          patch(id, () => ({ content: reply, steps: ['Preparing the change'] }));
          const ex = await dianaExtractActions(history.slice(0, -1).concat([{ role: 'user', content: text }]), reply, state, Date.now());
          if (ex.actions.length) { acts = ex.actions; Object.assign(refs, ex.refs); reply = reply.replace(/\s*\[proposed changes\]\s*/gi, '\n\n').replace(/\s*$/, '') + '\n\n```actions\n' + JSON.stringify(acts) + '\n```'; repaired = 'fixed'; }
          else repaired = claimed ? 'none' : null;
        } catch (e) { repaired = claimed ? 'error' : null; }
      }
      if (fakeBlock && !acts.length) reply = reply.replace(/\s*\[proposed changes\]\s*/gi, '\n\n').trim();
      patch(id, (x) => ({ content: reply || x.content, pending: false, actions: acts, refs, steps: r.steps.map((x) => x.tool), note: repaired === 'none' || repaired === 'error' ? 'Diana didn’t actually change anything. Try asking again, or make the change yourself.' : null }));
      if (mode === 'auto' && acts.length && acts.every((a) => AGENT_SMALL.has(a.op))) {
        const list = acts.map((a) => ({ ...a, task: a.task && refs[a.task], meeting: a.meeting && refs[a.meeting] }));
        const said = acts.map((a) => describeAction(a, refs, state)).filter(Boolean);
        A.applyActions(list, run, id);
        if (typeof stewardEvents === 'object') stewardEvents.record('proposal_decision', { entity: 'diana', actor: 'user', corr: run, proposal: id, data: { decision: 'auto_applied', applied: list.length, proposed: acts.length } });
        patch(id, () => ({ applied: 'Done automatically: ' + said.join('; ') + '. Press Undo to reverse.' }));
      }
    } catch (e) { patch(id, (x) => ({ content: (e.partial || x.content) + '\n[Error: ' + e.message + ']', pending: false })); return; }
    if (msgsRef.current.filter((m) => !m.summarized && m.role === 'user').length >= 6) remember();
    if (prefs.learn || /^\s*(please\s+)?remember\b/i.test(text)) {
      try { const learned = await kinLearnFrom(text, reply); if (learned.length) patch(id, () => ({ learned: learned.map((m) => m.text) })); } catch (e) {}
    }
  };
  const addDoc = async (f) => {
    const sp = kinSpace();
    if (!f) return;
    if (!sp || !sp.url || !sp.key || sp.id) { setToast({ text: 'Connect your Steward server in Settings to add documents', id: uid() }); return; }
    try {
      const r = await fetch(sp.url + '/v1/docs', { method: 'POST', headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, data: await docReadB64(f) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 404 ? 'your Steward server needs updating' : j.error || 'server error ' + r.status);
      setToast({ text: j.name + ' added. Diana can use it now.', id: uid() });
    } catch (e) { setToast({ text: f.name + ': ' + (e.message === 'Failed to fetch' ? 'couldn’t reach your Steward server' : e.message), id: uid() }); }
  };
  const addLine = (key, line) => { runCommand(line); setAdded((a) => ({ ...a, [key]: true })); setToast({ text: 'Added to your planner', id: uid() }); };
  const quick = ['What should I focus on today?', 'Break my biggest task into smaller steps', 'What have you learned about me?'];
  useEffect(() => { if (actx && actx.question) { const q = actx.question; const c = { ...actx, question: null }; setActx(c); kinSave(DIANA_CTX_KEY, c); send(q); } }, []);
  useEffect(() => { if (ready && pendingText && !busy) { const t = pendingText; setPending(null); send(t); } }, [ready, pendingText]);
  useEffect(() => { if (kinAI.status === 'error' && pendingText) { setInput(pendingText); setPending(null); } }, [kinAI.status]);
  const pats = learnedPatterns(state);
  const m = kinAI.model;
  return html`<div class="dws">
    <header class="dws-head">
      <div class="dws-title"><${Icon} n="diana" cls="diana-mark" /><h1>Diana</h1></div>
      <span class="dws-status" title=${ready ? (m ? m.name : '') : ''}><i class=${ready ? 'on' : kinAI.status === 'loading' ? 'busy' : ''}></i>${ready ? (kinAI.device === 'cloud' ? 'Local' : 'On this device') + (m && m.name ? ' · ' + m.name : '') : kinAI.status === 'loading' ? 'Loading…' : 'Not connected'}</span>
      <span style=${{ flex: 1 }}></span>
      <div class="dws-menu">
        <button class="btn sm ghost" aria-haspopup="menu" aria-expanded=${menu} onClick=${() => setMenu(!menu)} aria-label="More">···</button>
        ${menu ? html`<div class="dws-pop" role="menu" onMouseLeave=${() => setMenu(false)}>
          <button role="menuitem" disabled=${busy || !msgs.length} onClick=${async () => { setMenu(false); await remember(); setMsgs([]); setAdded({}); try { localStorage.removeItem(KIN_COMPACT_KEY); } catch (e) {} }}>Clear chat</button>
          <button role="menuitem" onClick=${() => { setMenu(false); ctx.setView('settings'); setTimeout(() => { const el = document.getElementById('diana-settings'); el && el.scrollIntoView({ block: 'start' }); }, 60); }}>Diana settings</button>
        </div>` : null}
      </div>
    </header>
    <div class="dws-scroll" ref=${scrollRef} onScroll=${onScroll} aria-live="polite">
      <div class="dws-col">
        ${!msgs.length && !pendingText ? html`<div class="dws-empty">
          <p>${ci ? 'Ask Diana about ' + ci.label.replace(/^(Project|Task|Decision): /, '') + '.' : 'Ask Diana about your plans, or tell her about yourself: your work, routines and goals. She remembers what matters.'}</p>
          ${!ready && !kinCloudAvailable() ? html`<p class="small muted">Diana isn’t connected yet. <button class="btn sm ghost" onClick=${() => ctx.setView('settings')}>Connect in Settings</button></p>` : null}
        </div>` : null}
        ${msgs.map((x) => html`<div key=${x.id} class=${'dmsg ' + (x.role === 'user' ? 'user' : 'diana')}>
          <div class="who">${x.role === 'user' ? html`<span class="diana-label">You</span>` : html`<${Icon} n="diana" cls="diana-mark" /><span class="diana-label">Diana</span>`}</div>
          <div class="body">${x.role === 'assistant' ? (() => { const r = chatActions(x.content); const t = kinPlain(r.clean); return t ? t + (x.pending && r.partial ? '\n\nPreparing changes…' : '') : x.pending ? html`<span class="thinking">Thinking…</span>` : ''; })() : x.content}</div>
          ${x.role === 'assistant' && (x.steps || []).length ? html`<div class="small muted" style=${{ marginTop: '6px' }}>${x.steps.map((t) => AGENT_TOOL_LABEL[t] || t).join(' · ')}${x.pending ? '…' : ''}</div>` : null}
          ${x.role === 'assistant' && !x.pending && (x.actions || []).length ? html`<${ActionCard} x=${x} state=${state} A=${A} patch=${patch} />` : null}
          ${x.role === 'assistant' && !x.pending ? chatTaskLines(x.content).map((line, i) => { const k = x.id + ':' + i; return html`<div key=${k} style=${{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}><button class="btn sm" disabled=${added[k]} onClick=${() => addLine(k, line)}>${added[k] ? 'Added' : '+ Add'}</button><span class="small">${line}</span></div>`; }) : null}
          ${x.note ? html`<div class="small" style=${{ marginTop: '6px', color: 'var(--warn)' }}>${x.note}</div>` : null}
          ${x.learned ? html`<div class="small muted" style=${{ marginTop: '6px' }}>Learned: ${x.learned.join(' · ')} <button class="btn sm ghost" onClick=${() => { ctx.setView('settings'); setTimeout(() => { const el = document.getElementById('diana-settings'); el && el.scrollIntoView({ block: 'start' }); }, 60); }}>Review</button></div>` : null}
        </div>`)}
        ${pendingText ? html`<div class="dmsg user"><div class="who"><span class="diana-label">You</span></div><div class="body">${pendingText}</div><div class="small muted" style=${{ marginTop: '4px' }}>Diana is loading and will reply when she’s ready…</div></div>` : null}
        ${pendingText ? html`<div class="dmsg user"><div class="who"><span class="diana-label">You</span></div><div class="body">${pendingText}</div><div class="small muted" style=${{ marginTop: '4px' }}>Diana is loading and will reply when she’s ready…</div></div>` : null}
      </div>
    </div>
    <div class="dws-foot">
      <div class="dws-col">
        ${jump ? html`<button class="dws-jump" onClick=${() => toBottom(true)}>↓ ${thinking ? 'Jump to response' : 'Latest'}</button>` : null}
        ${!msgs.length ? html`<div class="dws-prompts">${(ci ? ci.chips : quick).map((q) => html`<button key=${q} class="dws-prompt" disabled=${busy} onClick=${() => send(q)}>${q}</button>`)}</div>` : null}
        <div class=${'diana-bar diana-composer' + (thinking ? ' is-thinking' : '')}><div class="diana-bar-glass">
        <form class="dc-row" onSubmit=${(e) => { e.preventDefault(); send(); }}>
          <${Icon} n="diana" cls="diana-mark" />
          <input value=${input} onInput=${(e) => setInput(e.target.value)} placeholder=${ready ? (ci ? 'Ask Diana about this…' : 'Ask Diana anything, or tell her about yourself…') : 'Type a message — Diana will answer as soon as she’s loaded'} aria-label="Message Diana" autocomplete="off" />
          ${busy ? html`<button class="btn sm" type="button" onClick=${() => kinAI.stop()}>Stop</button>` : input.trim() ? html`<button class="btn pri sm" type="submit">Send</button>` : html`<kbd aria-hidden="true">↵</kbd>`}
        </form>
          <div class="dc-tools">
            <button class="dc-chip dc-icon" type="button" title="Add a document for Diana" aria-label="Add a document" onClick=${() => fileRef.current && fileRef.current.click()}>+</button>
            <input ref=${fileRef} type="file" accept=".md,.txt,.pdf" hidden onChange=${(e) => { addDoc(e.target.files[0]); e.target.value = ''; }} />
            ${ci ? html`<span class="dc-chip dc-ctxchip" title="Diana gets the details of this with each message"><${Icon} n="diana" cls="diana-mark" />${ci.label.replace(/^(Project|Task|Decision): /, '')}<button type="button" onClick=${clearCtx} aria-label="Stop talking about this">×</button></span>` : null}
            <label class="dc-chip dc-select" title=${(AGENT_MODES[prefs.mode || 'ask'] || {}).hint}>Changes:<select value=${prefs.mode || 'ask'} onChange=${(e) => setPrefs({ mode: e.target.value })} aria-label="What Diana may change">${Object.entries({ ask: 'Ask', auto: 'Auto (small)', plan: 'Plan only' }).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select></label>
            <span style=${{ flex: 1 }}></span>
            <span class="dc-state"><i></i>${thinking ? 'Thinking…' : ready ? 'Ready' : kinAI.status === 'loading' ? 'Loading…' : 'Not connected'}</span>
          </div>
        </div></div>
      </div>
    </div>
  </div>`;
}

/* Work email: read-only status of the Power Automate feed on the Steward server. */
function WorkEmailStatus() {
  const [st, setSt] = useState(null);
  useEffect(() => { if (typeof agentEmailOn === 'function' && agentEmailOn()) agentEmail('/v1/email/status').then(setSt).catch((e) => setSt({ error: e.message })); }, []);
  if (!(typeof agentEmailOn === 'function' && agentEmailOn())) return null;
  return html`<section class="panel" style=${{ marginBottom: '16px' }}><div class="ph"><h2>Work email</h2></div>
    <p class="small" style=${{ padding: '0 16px 14px', margin: 0, color: st && st.error ? 'var(--bad)' : 'var(--ink-2)' }}>${!st ? 'Checking…' : st.error && !st.messages ? st.error
      : st.messages + ' messages in ' + st.threads + ' conversations' + (st.awaiting ? ' · ' + st.awaiting + ' waiting on you' : '') + (st.synced ? ' · updated ' + fmtT(st.synced * 1000) : '') + (st.error ? ' · showing the last good copy (' + st.error + ')' : '')}
      <br /><span class="muted">Read-only. Diana can look up who's waiting on you and draft replies for you to copy; she can't send anything.</span></p></section>`;
}

/* Settings → Diana: connection, model, private mode, documents, memory, learning and the replay test. */
function DianaSettings({ state, plan, commit, setToast }) {
  const [, force] = useState(0);
  const [prefs, setPrefsRaw] = useState(() => ({ autoLoad: true, learn: true, ...kinLoad(KIN_PREF_KEY, {}) }));
  const setPrefs = (p) => setPrefsRaw((x) => { const n = { ...x, ...p }; kinSave(KIN_PREF_KEY, n); return n; });
  useEffect(() => { const f = () => force((n) => n + 1); kinAI.subs.add(f); kinMem.subs.add(f); return () => { kinAI.subs.delete(f); kinMem.subs.delete(f); }; }, []);
  const ready = kinAI.status === 'ready', busy = kinAI.generating;
  const pats = learnedPatterns(state);
  const m = kinAI.model;
  const restart = () => { kinAI.cloudOff = false; kinAI.unload(); setTimeout(() => kinAI.load(), 0); };
  const [spUrl, setSpUrl] = useState('');
  const [spKey, setSpKey] = useState('');
  const [checking, setChecking] = useState(false);
  const connect = async () => {
    const url = kinSpaceUrl(spUrl);
    if (!url) { setToast({ text: 'Enter your server’s address, like http://localhost:8787', id: uid() }); return; }
    setChecking(true);
    try {
      const res = await fetch(url + '/health', { cache: 'no-store' });
      const raw = await res.text();
      let info;
      try { info = JSON.parse(raw); }
      catch (e) { setToast({ text: 'Hugging Face replied (' + res.status + '): ' + raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220), id: uid() }); return; }
      if (!info.configured) { setToast({ text: 'Found the server, but its STEWARD_KEY isn’t set yet (see steward.env)', id: uid() }); return; }
      // An empty chat is rejected with 401 for a wrong key and 400 for a right one, without using any credits.
      const probe = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + spKey.trim(), 'Content-Type': 'application/json' }, body: '{"messages":[]}' });
      if (probe.status === 401) { setToast({ text: 'That Steward key doesn’t match the one on your server', id: uid() }); return; }
      const idm = spUrl.trim().match(/([\w.-]+)\/([\w.-]+)\/?$/);
      kinSave(KIN_SPACE_KEY, { url, key: spKey.trim(), docs: info.documents || 0, id: idm ? idm[1] + '/' + idm[2] : null }); dispatchEvent(new Event('steward-space'));
      setSpUrl(''); setSpKey(''); restart();
      setToast({ text: 'Connected to your Steward server' + (info.documents ? ' · ' + info.documents + ' document' + (info.documents === 1 ? '' : 's') : ''), id: uid() });
    } catch (e) {
      setToast({ text: 'Couldn’t reach that server (' + (e.message || e) + '). Check that it’s running and the address is right', id: uid() });
    } finally { setChecking(false); }
  };
  const disconnect = () => { try { localStorage.removeItem(KIN_SPACE_KEY); } catch (e) {} dispatchEvent(new Event('steward-space')); restart(); setToast({ text: 'Disconnected from your Steward server on this device', id: uid() }); };
  const sp = kinSpace();
  // Spaces connected before the id was saved: "user-name.hf.space" → "user/name" (usernames rarely contain hyphens).
  if (sp && !sp.id) { const h = sp.url.replace(/^https:\/\//, '').replace(/\.hf\.space$/, ''); const i = h.indexOf('-'); if (i > 0) sp.id = h.slice(0, i) + '/' + h.slice(i + 1); }

  return html`<div id="diana-settings" style=${{ marginTop: '28px' }}>
    <h2 class="set-h">Diana</h2>
    <section class="panel" style=${{ marginBottom: '16px' }}>
      ${prefs.onDevice ? html`
        <div style=${{ padding: '12px 16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <b>${m && m.key !== 'cloud' ? m.name : KIN_MODELS.main.name}</b>
          <span class="muted small">${ready ? (kinAI.device === 'cloud' ? 'Ready · via your Steward server' : 'Ready on ' + (kinAI.device === 'webgpu' ? 'GPU' : 'CPU') + ' · on this device') : kinAI.status === 'loading' ? 'Loading… ' + kinAI.progress : kinAI.status === 'error' ? 'Failed to load' : 'Not loaded · ' + KIN_MODELS.main.size + ' one-time download'}</span>
          <span style=${{ flex: '1' }}></span>
          ${kinAI.status !== 'loading' && !ready ? html`<button class="btn pri sm" onClick=${() => kinAI.load()}>Load Diana</button>` : null}
          ${ready ? html`<button class="btn sm ghost" disabled=${busy} onClick=${() => kinAI.unload()}>Unload</button>` : null}
          <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${prefs.autoLoad} onChange=${(e) => setPrefs({ autoLoad: e.target.checked })} />Load when I open Steward</label>
          <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!prefs.onDevice} disabled=${busy} onChange=${(e) => { setPrefs({ onDevice: e.target.checked }); restart(); }} />Private mode (on-device, slower)</label>
        </div>
        ${kinAI.note ? html`<p class="small muted" style=${{ padding: '0 16px 12px' }}>${kinAI.note}</p>` : null}
        ${kinAI.status === 'error' ? html`<p class="small" style=${{ padding: '0 16px 12px', color: 'var(--danger,#c33)' }}>${kinAI.error}</p>` : null}
        <p class="small muted" style=${{ padding: '0 16px 12px' }}>Private mode runs a small AI on this device. Nothing is sent anywhere, but it's slower and less capable. The first load downloads the model once.</p>`
      : kinCloudAvailable() ? html`
        <div style=${{ padding: '12px 16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <b>${m && m.key === 'cloud' ? m.name : 'Your Steward server'}</b>
          <span class="muted small">Ready · via your Steward server${sp.docs ? ' · ' + sp.docs + ' document' + (sp.docs === 1 ? '' : 's') : ''}</span>
          <span style=${{ flex: '1' }}></span>
          ${sp.id ? html`<a class="btn sm ghost" href=${'https://huggingface.co/spaces/' + sp.id + '/upload/main/docs'} target="_blank" rel="noopener">Add documents</a>` : null}
          <button class="btn sm ghost" onClick=${disconnect}>Disconnect</button>
          <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!prefs.onDevice} disabled=${busy} onChange=${(e) => { setPrefs({ onDevice: e.target.checked }); restart(); }} />Private mode (on-device, slower)</label>
        </div>`
      : html`
      <div style=${{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
        ${kinCloudAvailable()
          ? html`<div class="small" style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><span class="muted">Connected to ${/hf\.space/.test(sp.url) ? 'your Hugging Face Space' : 'your Steward server'} (${sp.url.replace(/^https?:\/\//, '')})${sp.docs ? ' · ' + sp.docs + ' document' + (sp.docs === 1 ? '' : 's') : ''}.</span><button class="btn sm ghost" onClick=${disconnect}>Disconnect</button></div>`
          : html`<form style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }} onSubmit=${(e) => { e.preventDefault(); connect(); }}>
              <span class="small" style=${{ flex: '1 1 100%' }}><b>Faster, smarter answers:</b> connect your Steward server. On the computer running it, use <b>http://localhost:8787</b>; on your phone, its Tailscale address. Enter the Steward key from steward.env.</span>
              <input class="in" value=${spUrl} onInput=${(e) => setSpUrl(e.target.value)} placeholder="http://localhost:8787" aria-label="Server address" autocomplete="off" style=${{ flex: '1', minWidth: '180px' }} />
              <input class="in" type="password" value=${spKey} onInput=${(e) => setSpKey(e.target.value)} placeholder="Steward key" aria-label="Steward key" autocomplete="off" style=${{ flex: '1', minWidth: '160px' }} />
              <button class="btn pri sm" type="submit" disabled=${!spUrl.trim() || spKey.trim().length < 8 || checking}>${checking ? 'Checking…' : 'Connect'}</button>
            </form>`}
      </div>
        <div style=${{ padding: '0 16px 12px' }}><label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!prefs.onDevice} disabled=${busy} onChange=${(e) => { setPrefs({ onDevice: e.target.checked }); restart(); }} />Private mode (on-device, slower)</label></div>`}
    </section>

    <${WorkEmailStatus} />
    <${DocsPanel} setToast=${setToast} />
    <${MemoryPanel} prefs=${prefs} setPrefs=${setPrefs} pats=${pats} setToast=${setToast} />
    <${LearningPanels} state=${state} commit=${commit} setToast=${setToast} />
    <details class="panel" style=${{ marginTop: '16px' }}><summary style=${{ padding: '12px 16px', cursor: 'pointer' }}>Test Diana (compare versions)</summary>
      <${ReplayTest} state=${state} plan=${plan} chat=${kinLoad(KIN_CHAT_KEY, [])} setToast=${setToast} />
    </details>
  </div>`;
}

/* Documents Diana reads, kept on the Steward server (~/Steward/docs). Adding one here uploads it there,
 * and she can use it right away. With a project, files are also linked to that project. */
const docReadB64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => bad(new Error('Couldn’t read ' + file.name)); r.readAsDataURL(file); });
function DocsPanel({ setToast, p, A, compact }) {
  const sp = kinSpace();
  const own = sp && sp.url && sp.key && !sp.id;
  const [docs, setDocs] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef();
  const call = (path, opt) => fetch(sp.url + path, { ...opt, headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' } });
  const load = async () => {
    try {
      const r = await call('/v1/docs');
      if (r.status === 404) { setErr('update'); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Server error ' + r.status);
      setDocs((await r.json()).docs); setErr('');
    } catch (e) { setErr(e.message === 'Failed to fetch' ? 'offline' : e.message); }
  };
  useEffect(() => { if (own) load(); }, []);
  const upload = async (files) => {
    const names = [];
    for (const f of files) {
      if (!/\.(md|txt|pdf)$/i.test(f.name)) { setToast({ text: f.name + ': only .md, .txt and .pdf files', id: uid() }); continue; }
      setBusy('Adding ' + f.name + '…');
      try {
        const r = await call('/v1/docs', { method: 'POST', body: JSON.stringify({ name: f.name, data: await docReadB64(f) }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Server error ' + r.status);
        names.push(j.name);
      } catch (e) { setToast({ text: f.name + ': ' + (e.message === 'Failed to fetch' ? 'couldn’t reach your Steward server' : e.message), id: uid() }); }
    }
    setBusy('');
    if (names.length) {
      if (p && A) A.updProject(p.id, { docs: [...new Set([...(p.docs || []), ...names])] });
      setToast({ text: (names.length === 1 ? names[0] : names.length + ' documents') + ' added. Diana can use ' + (names.length === 1 ? 'it' : 'them') + ' now.', id: uid() });
    }
    load();
  };
  const remove = async (name) => {
    if (p && A) { A.updProject(p.id, { docs: (p.docs || []).filter((x) => x !== name) }); return; }
    if (!confirm('Remove “' + name + '” from Diana? This deletes it from ~/Steward/docs.')) return;
    const r = await call('/v1/docs/' + encodeURIComponent(name), { method: 'DELETE' }).catch(() => null);
    if (!r || !r.ok) setToast({ text: 'Couldn’t remove it', id: uid() });
    load();
  };
  if (!own) {
    if (p) return null;
    return html`<section class="panel" style=${{ marginBottom: '16px' }}><div class="ph"><h2>Documents</h2></div>
      <p class="muted small" style=${{ padding: '0 16px 16px', margin: 0 }}>Connect your Steward server above to add documents here. Diana reads them in her answers.</p></section>`;
  }
  const list = (docs || []).filter((d) => !p || (p.docs || []).includes(d.name));
  const input = html`<input ref=${fileRef} type="file" multiple accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf" hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />`;
  const msg = err === 'update' ? 'Your Steward server needs updating to add documents from here (see the update step in the server README).' : err === 'offline' ? 'Your Steward server isn’t reachable right now. Start Steward on your laptop.' : err;
  if (p) return html`<div>
    ${list.map((d) => html`<div key=${d.name} class="row"><span></span><div class="t"><b>${d.name}</b><small>Diana can read this</small></div><button class="btn sm ghost" onClick=${() => remove(d.name)}>Unlink</button></div>`)}
    ${(p.docs || []).filter((n) => docs && !docs.some((d) => d.name === n)).map((n) => html`<div key=${n} class="row"><span></span><div class="t"><b>${n}</b><small>No longer on the server</small></div><button class="btn sm ghost" onClick=${() => remove(n)}>Unlink</button></div>`)}
    <div class="row"><span></span><div class="t"><small class=${err ? 'bad-t' : 'muted'}>${busy || msg || ''}</small></div><button class="btn sm ghost" disabled=${!!busy || !!err} onClick=${() => fileRef.current.click()}><${Icon} n="plus" />Add file</button></div>
    ${input}
  </div>`;
  return html`<section class="panel" style=${{ marginBottom: '16px' }}>
    <div class="ph"><h2>Documents Diana reads</h2><span class="grow"></span><button class="btn sm pri" disabled=${!!busy || !!err} onClick=${() => fileRef.current.click()}><${Icon} n="plus" />Add documents</button></div>
    <p class="muted small" style=${{ padding: '0 16px', margin: '0 0 10px' }}>${busy || msg || '.md, .txt or .pdf. They’re saved on your laptop in ~/Steward/docs, and Diana can use them right away.'}</p>
    ${docs && !docs.length ? html`<p class="muted small" style=${{ padding: '0 16px 16px', margin: 0 }}>None yet. A good first one: a page about you and your work.</p>` : null}
    <div>${list.map((d) => html`<div key=${d.name} style=${{ display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 16px', borderTop: '1px solid var(--line)' }}>
      <span style=${{ flex: 1 }}>${d.name}</span><span class="small muted">${d.size >= 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(d.size / 1024)) + ' KB'} · ${fmtD(d.updated)}${d.passages ? '' : ' · no readable text'}</span>
      <button class="btn sm ghost" onClick=${() => remove(d.name)}>Remove</button></div>`)}</div>
    ${input}
  </section>`;
}

function MemoryPanel({ prefs, setPrefs, pats, setToast }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null);
  const fileRef = useRef();
  const exportMem = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'steward-memory', version: 1, items: kinMem.items }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'steward-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importMem = (file) => file && file.text().then((t) => {
    const d = JSON.parse(t); let n = 0;
    (Array.isArray(d.items) ? d.items : []).forEach((m) => { if (m && typeof m.text === 'string' && kinMem.add(m.text, m.source || 'you')) n++; });
    setToast({ text: 'Imported ' + n + ' memor' + (n === 1 ? 'y' : 'ies'), id: uid() });
  }).catch(() => setToast({ text: 'That file isn’t a Steward memory backup', id: uid() }));
  return html`<div>
    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div class="ph"><h2>What Diana knows about you</h2><span class="grow"></span>
        <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${prefs.learn} onChange=${(e) => setPrefs({ learn: e.target.checked })} />Learn from our chats</label></div>
      <form style=${{ padding: '12px 16px', display: 'flex', gap: '8px' }} onSubmit=${(e) => { e.preventDefault(); if (kinMem.add(draft, 'you')) setDraft(''); else setToast({ text: 'Already known', id: uid() }); }}>
        <input class="in" value=${draft} onInput=${(e) => setDraft(e.target.value)} placeholder="Teach Diana something, e.g. “I do my best thinking before 10am”" aria-label="New memory" />
        <button class="btn pri sm" type="submit" disabled=${draft.trim().length < 4}>Add</button>
      </form>
      ${!kinMem.items.length ? html`<p class="muted small" style=${{ padding: '0 16px 16px' }}>Nothing yet. As you chat, Diana will save lasting facts here: your role, routines, goals, and preferences. You can edit or delete anything.</p>` : null}
      <div>${kinMem.items.map((m) => html`<div key=${m.id} style=${{ display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 16px', borderTop: '1px solid var(--line)' }}>
        ${editing === m.id
          ? html`<input class="in" autoFocus value=${m.text} onInput=${(e) => kinMem.update(m.id, e.target.value)} onBlur=${() => setEditing(null)} onKeyDown=${(e) => e.key === 'Enter' && setEditing(null)} aria-label="Edit memory" />`
          : html`<span style=${{ flex: '1' }}>${m.text}</span><span class="small muted">${m.source === 'you' ? 'you told me' : 'learned'} · ${fmtD(m.created)}</span>`}
        <button class="btn sm ghost" onClick=${() => setEditing(editing === m.id ? null : m.id)}>${editing === m.id ? 'Done' : 'Edit'}</button>
        <button class="btn sm ghost" onClick=${() => kinMem.remove(m.id)} aria-label="Forget this">Forget</button>
      </div>`)}</div>
      <div style=${{ padding: '12px 16px', display: 'flex', gap: '8px', flexWrap: 'wrap', borderTop: '1px solid var(--line)' }}>
        <button class="btn sm" onClick=${exportMem} disabled=${!kinMem.items.length}>Back up memory</button>
        <button class="btn sm" onClick=${() => fileRef.current.click()}>Restore from file</button>
        <input ref=${fileRef} type="file" accept=".json,application/json" hidden onChange=${(e) => { importMem(e.target.files[0]); e.target.value = ''; }} />
        ${kinMem.items.length ? html`<button class="btn sm ghost" onClick=${() => { if (confirm('Forget everything Diana has learned about you?')) { kinMem.gone = { ...kinMem.gone, ...Object.fromEntries(kinMem.items.map((m) => [m.id, Date.now()])) }; kinSave(KIN_MEM_KEY + '.gone', kinMem.gone); kinMem.commit([]); } }}>Forget everything</button>` : null}
      </div>
    </section>
    <section class="panel">
      <div class="ph"><h2>Patterns from your planner</h2></div>
      <div style=${{ padding: '12px 16px' }}>
        ${pats.length ? pats.map((p) => html`<p key=${p} style=${{ margin: '0 0 6px' }}>• ${p}</p>`) : html`<p class="muted small" style=${{ margin: 0 }}>Complete a few more tasks and Steward will start noticing how you work: your estimates, best times of day, and deadlines.</p>`}
        <p class="small muted" style=${{ margin: '10px 0 0' }}>These update automatically as you use the planner, and Diana uses them in every answer.</p>
      </div>
    </section>
  </div>`;
}
