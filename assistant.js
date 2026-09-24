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
const KIN_SPACE_KEY = 'steward.space.v1';
try { localStorage.removeItem('steward.hf.token'); } catch (e) {} // tokens now live only in the Space
const kinSpace = () => kinLoad(KIN_SPACE_KEY, null);
const kinCloudAvailable = () => { const sp = kinSpace(); return !!(sp && sp.url && sp.key); };
/* Accepts "user/space", huggingface.co/spaces/user/space, or the direct *.hf.space address. */
function kinSpaceUrl(input) {
  const t = String(input).trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9-]+\.hf\.space$/i.test(t)) return t.toLowerCase();
  const m = t.match(/^(?:https?:\/\/)?(?:huggingface\.co\/spaces\/)?([\w.-]+)\/([\w.-]+)$/i);
  return m ? 'https://' + (m[1] + '-' + m[2]).toLowerCase().replace(/[._]/g, '-') + '.hf.space' : null;
}
const KIN_CHAT_KEY = 'kin.planner.chat.v1';
const KIN_MEM_KEY = 'kin.planner.memory.v1';
const KIN_PREF_KEY = 'kin.planner.ai.v1';
const KIN_BASE = 'You are Steward, a personal planning assistant inside the user\'s planner. You know the user and get to know them better over time. Be clear, practical, warm, and honest. Help the user prioritize and take manageable next steps, and tailor advice to what you know about them. Keep replies short. When you suggest new tasks, put each on its own line starting with "- " and include a duration like 30m and a day if relevant. Use only the facts and planner snapshot below; never invent tasks, meetings, or facts about the user.';

const kinLoad = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const kinSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------- memory: what Steward has learned about you ---------- */
const kinMem = {
  items: kinLoad(KIN_MEM_KEY, []), subs: new Set(),
  commit(items) { this.items = items.slice(0, 300); kinSave(KIN_MEM_KEY, this.items); this.subs.forEach((f) => f()); },
  add(text, source) {
    text = String(text).trim().replace(/\s+/g, ' ').slice(0, 200);
    if (text.length < 4 || this.items.some((m) => kinSimilar(m.text, text))) return null;
    const m = { id: uid(), text, source, created: Date.now() };
    this.commit([m, ...this.items]);
    return m;
  },
  update(id, text) { this.commit(this.items.map((m) => (m.id === id ? { ...m, text } : m))); },
  remove(id) { this.commit(this.items.filter((m) => m.id !== id)); },
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
    this.set({ status: 'ready', device: 'cloud', model: { key: 'cloud', name: KIN_CLOUD_MODELS[i].name, cloud: i }, progress: '', error: '', note: '' });
  },
  async load(key) {
    if (!key && kinCloudAvailable() && !this.cloudOff && !kinLoad(KIN_PREF_KEY, {}).onDevice) { this.useCloud(); return; }
    if (!key) {
      this.set({ status: 'loading', progress: 'Checking for a GPU…', error: '' });
      let gpu = false;
      try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) {}
      if (!gpu) this.set({ note: 'This browser isn’t giving Steward access to the GPU, so it’s using the lighter 0.5B model on the CPU, which is slower. For the full 1.5B model and much faster replies, use a current version of Chrome or Edge.' });
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
        if (key === 'main') { this.set({ note: 'This device couldn’t run the 1.5B model (' + msg + '), so Steward is using the lighter 0.5B model.' }); this.load('fallback'); }
        else this.set({ status: 'error', error: 'Steward couldn’t start: ' + msg + (msg === d.message ? '.' : '. Close other tabs and press Load Steward to try again.') });
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
  ask({ messages, baseSystem, maxTokens = 320, temperature = 0.6, onChunk }) {
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
          try { return await kinCloudChat({ messages, maxTokens, temperature, onChunk }); }
          catch (e) {
            if (e.name === 'AbortError' || e.partial) throw e;
            // Hugging Face unavailable (offline, monthly limit, bad token): switch to the on-device model.
            this.cloudOff = true;
            this.set({ note: 'Hugging Face isn’t available right now (' + e.message + '), so Steward switched to the on-device AI.' });
            this.load();
            await this.whenReady();
          }
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
async function kinCloudChat({ messages, maxTokens, temperature, onChunk }) {
  const sp = kinSpace();
  const ctrl = new AbortController(); kinAI.abort = ctrl;
  let res;
  try {
    res = await fetch(sp.url + '/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
    });
  } catch (e) { kinAI.abort = null; if (e.name === 'AbortError') throw e; throw new Error('couldn’t reach your Space. It may be asleep or still starting'); }
  if (!res.ok) {
    kinAI.abort = null;
    let detail = ''; try { detail = (await res.json()).error || ''; } catch (e) {}
    throw new Error(res.status === 401 && /Steward key/.test(detail) ? 'the Steward key doesn’t match the Space'
      : res.status === 401 ? 'the Space’s HF_TOKEN was rejected. Check its permissions'
      : res.status === 402 ? 'the free monthly allowance is used up'
      : res.status === 500 && detail ? detail
      : 'error ' + res.status + (detail ? ': ' + detail.slice(0, 120) : ''));
  }
  const used = res.headers.get('X-Steward-Model');
  if (used) { const i = KIN_CLOUD_MODELS.findIndex((x) => x.id === used); const name = i >= 0 ? KIN_CLOUD_MODELS[i].name : used.split('/').pop(); if (!kinAI.model || kinAI.model.name !== name) kinAI.set({ model: { key: 'cloud', name } }); }
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
  const text = await kinAI.ask({ messages: [{ role: 'system', content: 'You extract facts. Output only the list or NONE.' }, { role: 'user', content: prompt }], maxTokens: 90, temperature: 0 });
  if (/^\s*none\b/i.test(text)) return [];
  return text.split('\n').map((l) => l.match(/^\s*[-*•]\s*(You\b.{3,180})$/i)).filter(Boolean)
    .map((m) => kinMem.add(m[1].replace(/\.?\s*$/, '.'), 'chat')).filter(Boolean).slice(0, 3);
}

function plannerSnapshot(state, plan, now) {
  const open = state.tasks.filter((t) => t.status !== 'done')
    .sort((a, b) => (PRI[a.priority] - PRI[b.priority]) || ((a.deadline || Infinity) - (b.deadline || Infinity))).slice(0, 15);
  const evs = state.events.filter((e) => e.end > now && e.start < addDays(sod(now), 7)).sort((a, b) => a.start - b.start).slice(0, 10);
  const today = plan.blocks.filter((b) => sod(b.start) === sod(now)).slice(0, 10);
  const title = (id) => (state.tasks.find((t) => t.id === id) || {}).title || 'task';
  const lines = ['Now: ' + fmtD(now) + ' ' + fmtT(now) + '.'];
  lines.push('Open tasks: ' + (open.length ? open.map((t) => t.title + ' (' + PRI_LABEL[t.priority] + ', ' + fmtDur(remainingMin(t)) + (t.deadline ? ', due ' + relD(t.deadline, now) : '') + ')').join('; ') : 'none') + '.');
  lines.push('Meetings next 7 days: ' + (evs.length ? evs.map((e) => e.title + ' ' + relD(e.start, now) + ' ' + fmtT(e.start)).join('; ') : 'none') + '.');
  lines.push('Scheduled today: ' + (today.length ? today.map((b) => fmtT(b.start) + ' ' + title(b.taskId)).join('; ') : 'nothing') + '.');
  const active = state.projects.filter((p) => p.status !== 'done');
  if (active.length) lines.push('Projects: ' + active.map((p) => p.name).join('; ') + '.');
  return lines.join('\n');
}

function kinSystem(state, plan, userText) {
  const facts = kinRecall(userText).map((m) => '- ' + m.text);
  const pats = learnedPatterns(state).map((p) => '- ' + p);
  return KIN_BASE
    + (facts.length ? '\n\nWhat you know about the user:\n' + facts.join('\n') : '')
    + (pats.length ? '\n\nPatterns noticed from their planner:\n' + pats.join('\n') : '')
    + '\n\nPlanner snapshot:\n' + plannerSnapshot(state, plan, Date.now());
}

const suggestionLines = (text) => text.split('\n').map((l) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,160})$/)).filter(Boolean).map((m) => m[1].replace(/\*\*/g, '').trim());

/* Load automatically on startup once the user has opted in. */
if (kinLoad(KIN_PREF_KEY, {}).autoLoad !== false) setTimeout(() => kinAI.status === 'idle' && kinAI.load(), 1500);

function AssistantView(ctx) {
  const { state, plan, runCommand, setToast } = ctx;
  const [, force] = useState(0);
  const [tab, setTab] = useState('chat');
  const [prefs, setPrefsRaw] = useState(() => ({ autoLoad: true, learn: true, ...kinLoad(KIN_PREF_KEY, {}) }));
  const [msgs, setMsgs] = useState(() => kinLoad(KIN_CHAT_KEY, []));
  const [input, setInput] = useState('');
  const [added, setAdded] = useState({});
  const [pendingText, setPending] = useState(null);
  const endRef = useRef();

  useEffect(() => { const f = () => force((n) => n + 1); kinAI.subs.add(f); kinMem.subs.add(f); return () => { kinAI.subs.delete(f); kinMem.subs.delete(f); }; }, []);
  useEffect(() => { kinSave(KIN_CHAT_KEY, msgs.filter((m) => !m.pending).slice(-60)); }, [msgs]);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ block: 'end' }); }, [msgs, tab]);
  const setPrefs = (p) => setPrefsRaw((x) => { const n = { ...x, ...p }; kinSave(KIN_PREF_KEY, n); return n; });

  const ready = kinAI.status === 'ready', busy = kinAI.generating;
  const patch = (id, fn) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, ...fn(x) } : x)));
  const send = async (text) => {
    text = (text || input).trim();
    if (!text || busy) return;
    if (!ready) {
      // Keep the message and send it as soon as the model is ready.
      setPending(text); setInput('');
      if (kinAI.status !== 'loading') kinAI.load();
      return;
    }
    const id = uid();
    const history = [...msgs.filter((m) => !m.pending && m.content), { role: 'user', content: text }].slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: text }, { id, role: 'assistant', content: '', pending: true }]);
    setInput('');
    let reply = '';
    try {
      reply = await kinAI.ask({ messages: [{ role: 'system', content: kinSystem(state, plan, text) }, ...history], baseSystem: KIN_BASE, onChunk: (c) => patch(id, (x) => ({ content: x.content + c })) });
      patch(id, (x) => ({ content: reply || x.content, pending: false }));
    } catch (e) { patch(id, (x) => ({ content: (e.partial || x.content) + '\n[Error: ' + e.message + ']', pending: false })); return; }
    if (prefs.learn || /^\s*(please\s+)?remember\b/i.test(text)) {
      try { const learned = await kinLearnFrom(text, reply); if (learned.length) patch(id, () => ({ learned: learned.map((m) => m.text) })); } catch (e) {}
    }
  };
  const addLine = (key, line) => { runCommand(line); setAdded((a) => ({ ...a, [key]: true })); setToast({ text: 'Added to your planner', id: uid() }); };
  const quick = ['What should I focus on today?', 'Break my biggest task into smaller steps', 'What have you learned about me?'];
  useEffect(() => { if (ready && pendingText && !busy) { const t = pendingText; setPending(null); send(t); } }, [ready, pendingText]);
  useEffect(() => { if (kinAI.status === 'error' && pendingText) { setInput(pendingText); setPending(null); } }, [kinAI.status]);
  const pats = learnedPatterns(state);
  const m = kinAI.model;
  const restart = () => { kinAI.cloudOff = false; kinAI.unload(); setTimeout(() => kinAI.load(), 0); };
  const [spUrl, setSpUrl] = useState('');
  const [spKey, setSpKey] = useState('');
  const [checking, setChecking] = useState(false);
  const connect = async () => {
    const url = kinSpaceUrl(spUrl);
    if (!url) { setToast({ text: 'Enter your Space like “yourname/steward”', id: uid() }); return; }
    setChecking(true);
    try {
      const res = await fetch(url + '/', { cache: 'no-store' });
      const info = await res.json();
      if (!info.configured) { setToast({ text: 'Found your Space, but its HF_TOKEN or STEWARD_KEY secret is missing', id: uid() }); return; }
      // An empty chat is rejected with 401 for a wrong key and 400 for a right one, without using any credits.
      const probe = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + spKey.trim(), 'Content-Type': 'application/json' }, body: '{"messages":[]}' });
      if (probe.status === 401) { setToast({ text: 'That Steward key doesn’t match the one in your Space', id: uid() }); return; }
      kinSave(KIN_SPACE_KEY, { url, key: spKey.trim(), docs: info.documents || 0 });
      setSpUrl(''); setSpKey(''); restart();
      setToast({ text: 'Connected to your Space' + (info.documents ? ' · ' + info.documents + ' document' + (info.documents === 1 ? '' : 's') : ''), id: uid() });
    } catch (e) {
      setToast({ text: 'Couldn’t reach that Space. If it’s asleep, wait 30 seconds and try again', id: uid() });
    } finally { setChecking(false); }
  };
  const disconnect = () => { try { localStorage.removeItem(KIN_SPACE_KEY); } catch (e) {} restart(); setToast({ text: 'Disconnected from your Space on this device', id: uid() }); };
  const sp = kinSpace();

  return html`<div>
    <header class="hdr"><div><div class="sub">Your planning AI · learns about you</div><h1>Assistant</h1></div><span class="grow"></span>
      <div class="seg" style=${{ display: 'flex', gap: '6px' }}>
        <button class=${'btn sm' + (tab === 'chat' ? ' pri' : ' ghost')} onClick=${() => setTab('chat')}>Chat</button>
        <button class=${'btn sm' + (tab === 'memory' ? ' pri' : ' ghost')} onClick=${() => setTab('memory')}>What I know (${kinMem.items.length})</button>
      </div></header>
    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div style=${{ padding: '12px 16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <b>${m ? m.name : kinCloudAvailable() && !prefs.onDevice ? KIN_CLOUD_MODELS[0].name : KIN_MODELS.main.name}</b>
        <span class="muted small">${ready ? (kinAI.device === 'cloud' ? 'Ready · via your Space' : 'Ready on ' + (kinAI.device === 'webgpu' ? 'GPU' : 'CPU') + ' · on this device') : kinAI.status === 'loading' ? 'Loading… ' + kinAI.progress : kinAI.status === 'error' ? 'Failed to load' : 'Not loaded · ' + KIN_MODELS.main.size + ' one-time download'}</span>
        <span class="grow" style=${{ flex: '1' }}></span>
        ${kinAI.status !== 'loading' && !ready ? html`<button class="btn pri sm" onClick=${() => kinAI.load()}>Load Steward</button>` : null}
        ${ready && kinAI.device !== 'cloud' ? html`<button class="btn sm ghost" disabled=${busy} onClick=${() => kinAI.unload()}>Unload</button>` : null}
        ${kinCloudAvailable() ? html`<label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!prefs.onDevice} disabled=${busy} onChange=${(e) => { setPrefs({ onDevice: e.target.checked }); restart(); }} />Private mode (on-device, slower)</label>` : null}
        <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${prefs.autoLoad} onChange=${(e) => setPrefs({ autoLoad: e.target.checked })} />Load when I open Steward</label>
      </div>
      ${kinAI.note ? html`<p class="small muted" style=${{ padding: '0 16px 12px' }}>${kinAI.note}</p>` : null}
      ${kinAI.status === 'error' ? html`<p class="small" style=${{ padding: '0 16px 12px', color: 'var(--danger,#c33)' }}>${kinAI.error}</p>` : null}
      ${kinAI.status === 'idle' ? html`<p class="small muted" style=${{ padding: '0 16px 12px' }}>The first load downloads the model from Hugging Face, then the browser caches it. Chrome or Edge on a recent computer is fastest (GPU). Everything, including what Steward learns about you, stays on this device.</p>` : null}
      <div style=${{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
        ${kinCloudAvailable()
          ? html`<div class="small" style=${{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}><span class="muted">Connected to your Space (${sp.url.replace('https://', '')})${sp.docs ? ' · ' + sp.docs + ' document' + (sp.docs === 1 ? '' : 's') : ''}. Chats are answered by a large model on Hugging Face.</span><button class="btn sm ghost" onClick=${disconnect}>Disconnect</button></div>`
          : html`<form style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }} onSubmit=${(e) => { e.preventDefault(); connect(); }}>
              <span class="small" style=${{ flex: '1 1 100%' }}><b>Faster, smarter answers:</b> connect your Steward Space on Hugging Face. Enter the Space name and the Steward key you gave it.</span>
              <input class="in" value=${spUrl} onInput=${(e) => setSpUrl(e.target.value)} placeholder="yourname/steward" aria-label="Space name" autocomplete="off" style=${{ flex: '1', minWidth: '180px' }} />
              <input class="in" type="password" value=${spKey} onInput=${(e) => setSpKey(e.target.value)} placeholder="Steward key" aria-label="Steward key" autocomplete="off" style=${{ flex: '1', minWidth: '160px' }} />
              <button class="btn pri sm" type="submit" disabled=${!spUrl.trim() || spKey.trim().length < 8 || checking}>${checking ? 'Checking…' : 'Connect'}</button>
            </form>`}
      </div>
    </section>

    ${tab === 'chat' ? html`<section class="panel">
      <div style=${{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '240px', maxHeight: '58vh', overflow: 'auto' }} aria-live="polite">
        ${!msgs.length ? html`<p class="muted small">Talk to Steward about your plans, and about yourself: your work, routines, and goals. It remembers what matters and uses it next time. Say “remember that…” to teach it something directly.</p>` : null}
        ${msgs.map((x) => html`<div key=${x.id} style=${{ alignSelf: x.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
          <div style=${{ whiteSpace: 'pre-wrap', lineHeight: '1.55', padding: '10px 13px', borderRadius: '12px', background: x.role === 'user' ? 'var(--accent-soft)' : 'var(--sunk)' }}>${x.content || (x.pending ? '…' : '')}</div>
          ${x.role === 'assistant' && !x.pending ? suggestionLines(x.content).map((line, i) => { const k = x.id + ':' + i; return html`<div key=${k} style=${{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}><button class="btn sm" disabled=${added[k]} onClick=${() => addLine(k, line)}>${added[k] ? 'Added' : '+ Add'}</button><span class="small">${line}</span></div>`; }) : null}
          ${x.learned ? html`<div class="small muted" style=${{ marginTop: '6px' }}>✦ Learned: ${x.learned.join(' · ')} <button class="btn sm ghost" onClick=${() => setTab('memory')}>Review</button></div>` : null}
        </div>`)}
        ${pendingText ? html`<div style=${{ alignSelf: 'flex-end', maxWidth: '85%' }}><div style=${{ whiteSpace: 'pre-wrap', padding: '10px 13px', borderRadius: '12px', background: 'var(--accent-soft)' }}>${pendingText}</div><div class="small muted" style=${{ marginTop: '4px', textAlign: 'right' }}>Steward is loading, and will reply when it’s ready…</div></div>` : null}
        <div ref=${endRef}></div>
      </div>
      <div style=${{ padding: '0 16px 8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        ${quick.map((q) => html`<button key=${q} class="btn sm ghost" disabled=${busy} onClick=${() => send(q)}>${q}</button>`)}
        ${msgs.length ? html`<button class="btn sm ghost" disabled=${busy} onClick=${() => { setMsgs([]); setAdded({}); }}>Clear chat</button>` : null}
      </div>
      <form class="cmd" style=${{ margin: '0 16px 16px' }} onSubmit=${(e) => { e.preventDefault(); send(); }}>
        <${Icon} n="spark" cls="muted" />
        <input value=${input} onInput=${(e) => setInput(e.target.value)} placeholder=${ready ? 'Ask Steward, or tell it about yourself…' : 'Type a message — Steward will answer as soon as it’s loaded'} aria-label="Message Steward" autocomplete="off" />
        ${busy ? html`<button class="btn sm" type="button" onClick=${() => kinAI.stop()}>Stop</button>` : html`<button class="btn pri sm" type="submit" disabled=${!input.trim()}>Send</button>`}
      </form>
    </section>` : html`<${MemoryPanel} prefs=${prefs} setPrefs=${setPrefs} pats=${pats} setToast=${setToast} />`}
  </div>`;
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
      <div class="ph"><h2>What Steward knows about you</h2><span class="grow"></span>
        <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${prefs.learn} onChange=${(e) => setPrefs({ learn: e.target.checked })} />Learn from our chats</label></div>
      <form style=${{ padding: '12px 16px', display: 'flex', gap: '8px' }} onSubmit=${(e) => { e.preventDefault(); if (kinMem.add(draft, 'you')) setDraft(''); else setToast({ text: 'Already known', id: uid() }); }}>
        <input class="in" value=${draft} onInput=${(e) => setDraft(e.target.value)} placeholder="Teach Steward something, e.g. “I do my best thinking before 10am”" aria-label="New memory" />
        <button class="btn pri sm" type="submit" disabled=${draft.trim().length < 4}>Add</button>
      </form>
      ${!kinMem.items.length ? html`<p class="muted small" style=${{ padding: '0 16px 16px' }}>Nothing yet. As you chat, Steward will save lasting facts here: your role, routines, goals, and preferences. You can edit or delete anything.</p>` : null}
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
        ${kinMem.items.length ? html`<button class="btn sm ghost" onClick=${() => { if (confirm('Forget everything Steward has learned about you?')) kinMem.commit([]); }}>Forget everything</button>` : null}
      </div>
    </section>
    <section class="panel">
      <div class="ph"><h2>Patterns from your planner</h2></div>
      <div style=${{ padding: '12px 16px' }}>
        ${pats.length ? pats.map((p) => html`<p key=${p} style=${{ margin: '0 0 6px' }}>• ${p}</p>`) : html`<p class="muted small" style=${{ margin: 0 }}>Complete a few more tasks and Steward will start noticing how you work: your estimates, best times of day, and deadlines.</p>`}
        <p class="small muted" style=${{ margin: '10px 0 0' }}>These update automatically as you use the planner, and Steward uses them in every answer.</p>
      </div>
    </section>
  </div>`;
}
