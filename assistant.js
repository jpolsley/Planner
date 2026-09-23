/* Kin Assistant — chat view for Kin Planner, powered by the Kin Studio in-browser engine (kin-engine.js).
 * The model downloads once from Hugging Face on "Load", is cached by the browser, and runs locally. */
const KIN_MODELS = Object.freeze({
  pocket: { key: 'pocket', name: 'Pocket · SmolLM2 135M', repo: 'HuggingFaceTB/SmolLM2-135M-Instruct', dtype: 'q8', context: 2048, size: '~140 MB' },
  standard: { key: 'standard', name: 'Standard · Qwen2.5 0.5B', repo: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q4', context: 4096, size: '~480 MB' },
});
const KIN_CHAT_KEY = 'kin.planner.chat.v1';
const KIN_BASE = 'You are Kin, a planning assistant inside the user\'s planner. Be clear, practical, and honest. Help the user prioritize and take manageable next steps. Keep replies short. When you suggest new tasks, put each on its own line starting with "- " and include a duration like 30m and a day if relevant. Never invent tasks or meetings the user already has; use only the planner snapshot below.';

/* One engine for the whole page, so switching views keeps the model loaded. */
const kinAI = {
  engine: null, status: 'idle', model: null, device: null, progress: '', error: '', subs: new Set(), onEvent: null,
  set(patch) { Object.assign(this, patch); this.subs.forEach((f) => f()); },
  load(key) {
    if (this.engine) this.engine.terminate();
    const model = KIN_MODELS[key];
    this.set({ status: 'loading', model, progress: 'Starting…', error: '' });
    const engine = createKinEngine((d) => {
      if (engine !== this.engine) return;
      if (d.type === 'progress') {
        const x = d.detail || {};
        const pct = typeof x.progress === 'number' ? ' ' + Math.round(x.progress) + '%' : '';
        this.set({ progress: (x.file ? String(x.file).split('/').pop() : x.status || '') + pct });
      } else if (d.type === 'ready') this.set({ status: 'ready', device: d.device, progress: '' });
      else if (d.type === 'error' && d.phase === 'load') this.set({ status: 'error', error: d.message });
      else if (d.type === 'fallback') this.set({ progress: d.text });
      if (this.onEvent) this.onEvent(d);
    }, { thread: 'direct', attempt: 1 });
    this.engine = engine;
    engine.postMessage({ type: 'init', model, device: 'auto' });
  },
  unload() { if (this.engine) this.engine.terminate(); this.set({ engine: null, status: 'idle', model: null }); },
};

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

const suggestionLines = (text) => text.split('\n').map((l) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.{3,160})$/)).filter(Boolean).map((m) => m[1].replace(/\*\*/g, '').trim());

function AssistantView(ctx) {
  const { state, plan, now, runCommand, setToast } = ctx;
  const [, force] = useState(0);
  const [modelKey, setModelKey] = useState('pocket');
  const [msgs, setMsgs] = useState(() => { try { return JSON.parse(localStorage.getItem(KIN_CHAT_KEY)) || []; } catch (e) { return []; } });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState({});
  const endRef = useRef();
  const reqRef = useRef(null);

  useEffect(() => { const f = () => force((n) => n + 1); kinAI.subs.add(f); return () => kinAI.subs.delete(f); }, []);
  useEffect(() => { try { localStorage.setItem(KIN_CHAT_KEY, JSON.stringify(msgs.slice(-60))); } catch (e) {} }, [msgs]);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ block: 'end' }); }, [msgs]);
  useEffect(() => {
    kinAI.onEvent = (d) => {
      if (!reqRef.current || d.requestId !== reqRef.current) return;
      if (d.type === 'chunk') setMsgs((m) => m.map((x) => (x.id === d.requestId ? { ...x, content: x.content + d.text } : x)));
      if (d.type === 'done') { setMsgs((m) => m.map((x) => (x.id === d.requestId ? { ...x, content: d.text || x.content, pending: false } : x))); setBusy(false); reqRef.current = null; }
      if (d.type === 'error' && d.phase === 'generate') { setMsgs((m) => m.map((x) => (x.id === d.requestId ? { ...x, content: (d.partial || '') + '\n[Error: ' + d.message + ']', pending: false } : x))); setBusy(false); reqRef.current = null; }
    };
    return () => { kinAI.onEvent = null; };
  }, []);

  const ready = kinAI.status === 'ready';
  const send = (text) => {
    text = (text || input).trim();
    if (!text || !ready || busy) return;
    const id = uid();
    const history = [...msgs.filter((m) => !m.pending && m.content), { role: 'user', content: text }].slice(-8);
    const system = KIN_BASE + '\n\nPlanner snapshot:\n' + plannerSnapshot(state, plan, Date.now());
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: text }, { id, role: 'assistant', content: '', pending: true }]);
    setInput(''); setBusy(true); reqRef.current = id;
    kinAI.engine.postMessage({ type: 'generate', requestId: id, messages: [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))], baseSystem: KIN_BASE, maxTokens: 256, temperature: 0.6 });
  };
  const stop = () => kinAI.engine && kinAI.engine.postMessage({ type: 'stop' });
  const addLine = (key, line) => { runCommand(line); setAdded((a) => ({ ...a, [key]: true })); setToast({ text: 'Added to your planner', id: uid() }); };
  const quick = ['What should I focus on today?', 'Break my biggest task into smaller steps', 'Am I overbooked this week?'];

  return html`<div>
    <header class="hdr"><div><div class="sub">On-device AI · no API key</div><h1>Assistant</h1></div></header>
    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div class="ph"><h2>Model</h2><span class="grow"></span>
        <span class="muted small">${ready ? 'Ready · ' + kinAI.model.name + ' on ' + kinAI.device : kinAI.status === 'loading' ? 'Loading… ' + kinAI.progress : kinAI.status === 'error' ? 'Failed to load' : 'Not loaded'}</span></div>
      <div style=${{ padding: '12px 16px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select class="in" style=${{ width: 'auto' }} value=${modelKey} onChange=${(e) => setModelKey(e.target.value)} disabled=${kinAI.status === 'loading'} aria-label="Model">
          ${Object.values(KIN_MODELS).map((m) => html`<option key=${m.key} value=${m.key}>${m.name} (${m.size})</option>`)}
        </select>
        <button class="btn pri sm" disabled=${kinAI.status === 'loading' || busy} onClick=${() => kinAI.load(modelKey)}>${ready ? 'Reload' : 'Load model'}</button>
        ${ready ? html`<button class="btn sm ghost" disabled=${busy} onClick=${() => kinAI.unload()}>Unload</button>` : null}
        ${msgs.length ? html`<button class="btn sm ghost" disabled=${busy} onClick=${() => { setMsgs([]); setAdded({}); }}>Clear chat</button>` : null}
      </div>
      ${kinAI.status === 'error' ? html`<p class="small" style=${{ padding: '0 16px 12px', color: 'var(--danger,#c33)' }}>${kinAI.error}</p>` : null}
      ${!ready && kinAI.status !== 'loading' ? html`<p class="small muted" style=${{ padding: '0 16px 12px' }}>The first load downloads the model from Hugging Face; after that it is cached. Small models can be wrong — review suggestions before adding them.</p>` : null}
    </section>
    <section class="panel">
      <div style=${{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '240px', maxHeight: '58vh', overflow: 'auto' }} aria-live="polite">
        ${!msgs.length ? html`<p class="muted small">Ask Kin about your plan. Suggested tasks show an “Add” button that sends them through the planner’s command bar.</p>` : null}
        ${msgs.map((m) => html`<div key=${m.id} style=${{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
          <div style=${{ whiteSpace: 'pre-wrap', lineHeight: 1.55, padding: '10px 13px', borderRadius: '12px', background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--sunk)' }}>${m.content || (m.pending ? '…' : '')}</div>
          ${m.role === 'assistant' && !m.pending ? suggestionLines(m.content).map((line, i) => { const k = m.id + ':' + i; return html`<div key=${k} style=${{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}><button class="btn sm" disabled=${added[k]} onClick=${() => addLine(k, line)}>${added[k] ? 'Added' : '+ Add'}</button><span class="small">${line}</span></div>`; }) : null}
        </div>`)}
        <div ref=${endRef}></div>
      </div>
      <div style=${{ padding: '0 16px 8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>${quick.map((q) => html`<button key=${q} class="btn sm ghost" disabled=${!ready || busy} onClick=${() => send(q)}>${q}</button>`)}</div>
      <form class="cmd" style=${{ margin: '0 16px 16px' }} onSubmit=${(e) => { e.preventDefault(); send(); }}>
        <${Icon} n="spark" cls="muted" />
        <input value=${input} onInput=${(e) => setInput(e.target.value)} placeholder=${ready ? 'Ask Kin about your plan…' : 'Load a model to start chatting'} disabled=${!ready} aria-label="Message Kin" autocomplete="off" />
        ${busy ? html`<button class="btn sm" type="button" onClick=${stop}>Stop</button>` : html`<button class="btn pri sm" type="submit" disabled=${!ready || !input.trim()}>Send</button>`}
      </form>
    </section>
  </div>`;
}
