/* Conversation guard: keeps Diana from looping (reflect → question → "yes" → reflect → question…).
 * It never changes what was said. It counts how many of Diana's recent turns only explored (asked, added
 * nothing), and after two in a row adds a short runtime note for this one request. The note is not the
 * user's words: it is never shown, saved, summarized, learned from, or replayed as history.
 * Obvious context (a project or task named in the message, T#/M# refs) is looked up by code up front
 * instead of spending a model turn on it. Also: the A–D replay test for comparing guard versions. */
const GUARD_KEY = 'steward.guard.v1';
const GUARD_VARIANTS = {
  current: 'Current (no guard)',
  guard: 'Reminder in instructions',
  guard_short: 'Reminder + short memory',
  guard_near: 'Reminder by your message',
};
const GUARD_DEFAULT = 'guard';
const GUARD_NOTE = 'RUNTIME GUIDANCE FOR THIS TURN (from Steward, not from the user): your last two or more replies on this topic explored without moving it forward, and you now know enough to help. For this reply: do not restate their concern, do not ask another broad or feelings question; say plainly what you think is going on and give one concrete next step, or use what Steward knows. Ask a question only if one specific missing fact would change your recommendation.';

const guardQuestions = (text) => (String(text).replace(/```[\s\S]*?```/g, '').match(/\?/g) || []).length;
const guardEndsWithQuestion = (text) => /\?["')\s]*$/.test(String(text).replace(/```[\s\S]*?```/g, '').replace(/Suggested tasks:[\s\S]*$/i, '').trim());

/* A Diana turn "advances" if it looked something up, proposed changes or tasks, or didn't end on a question. */
function guardTurnKind(m) {
  const t = String(m.content || '');
  if ((m.steps && m.steps.length) || (m.actions && m.actions.length) || /Suggested tasks:/i.test(t) || /```actions/.test(t)) return 'advance';
  if (guardEndsWithQuestion(t) && t.length < 900) return 'explore';
  return 'advance';
}
/* Consecutive exploratory Diana turns at the end of the conversation. */
function guardDepth(msgs) {
  let n = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || m.pending) continue;
    if (guardTurnKind(m) === 'explore') n++; else break;
  }
  return n;
}

/* High-confidence lookups only: a project whose name appears in the message (or recent turns), a task whose
 * full title appears, or T#/M# refs. At most 2 sources and about 1,200 characters, labeled with where they came from. */
function guardPrefetch(state, plan, refs, text, recent) {
  const hay = (' ' + text + ' ' + (recent || '') + ' ').toLowerCase();
  const out = [];
  const add = (source, label, body) => { if (out.length < 2 && !out.some((x) => x.label === label)) out.push({ source, label, body }); };
  for (const r of new Set(String(text).match(/\b[TM]\d+\b/g) || [])) {
    const id = refs[r];
    if (!id) continue;
    const t = state.tasks.find((x) => x.id === id);
    if (t) add('search_tasks', r + ' ' + t.title, agentTool('search_tasks', { query: t.title }, state, plan, refs).split('\n')[0]);
  }
  const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (const p of state.projects) {
    const name = p.name.toLowerCase();
    const w = words(name);
    const inText = (' ' + text.toLowerCase() + ' ').includes(name) || (w.length && w.every((x) => (' ' + text.toLowerCase() + ' ').includes(x)));
    const inRecent = name.length >= 4 && hay.includes(name);
    if (inText || inRecent) add('project_status', p.name, agentTool('project_status', { name: p.name }, state, plan, refs));
  }
  for (const t of state.tasks) {
    if (t.status === 'done' || t.title.length < 8) continue;
    if (text.toLowerCase().includes(t.title.toLowerCase())) add('search_tasks', t.title, agentTool('search_tasks', { query: t.title }, state, plan, refs).split('\n')[0]);
  }
  let left = 1200;
  return out.map((x) => { const body = x.body.slice(0, Math.max(0, left)); left -= body.length; return { ...x, body }; }).filter((x) => x.body);
}
const guardPrefetchBlock = (pf) => (pf.length ? '\n\nPREFETCHED STEWARD CONTEXT (looked up by Steward for this message):\n' + pf.map((x) => x.source + ': ' + x.label + '\n' + x.body).join('\n\n') : '');

/* Builds one request. msgs: the conversation before this message (as stored); text: the new user message. */
function guardRequest({ msgs, text, baseSystem, variant, state, plan, refs }) {
  const clean = msgs.filter((m) => !m.pending && m.content);
  const depth = guardDepth(clean);
  const fired = variant !== 'current' && depth >= 2;
  const recent = clean.slice(-4).map((m) => m.content).join(' ').slice(-2000);
  const pf = guardPrefetch(state, plan, refs, text, recent);
  const keep = fired && variant === 'guard_short' ? 4 : 8;
  const history = [...clean, { role: 'user', content: text }].slice(-keep).map((m) => ({ role: m.role, content: String(m.content).replace(/```actions[\s\S]*?```/g, '[proposed changes]') }));
  if (fired && variant === 'guard_near') history[history.length - 1] = { role: 'user', content: history[history.length - 1].content + '\n\n[' + GUARD_NOTE + ']' };
  const system = baseSystem + guardPrefetchBlock(pf) + (fired && variant !== 'guard_near' ? '\n\n' + GUARD_NOTE : '');
  return { system, history, meta: { guard_variant: variant, exploration_depth_before: depth, guard_fired: fired, history_len: history.length, prefetches: pf.map((x) => ({ source: x.source, label: x.label, chars: x.body.length })) } };
}

/* Plain counts about a reply. Evidence, not a score. */
function guardDiag(reply, steps) {
  const r = String(reply || '');
  return { ended_with_question: guardEndsWithQuestion(r), question_count: guardQuestions(r), tool_used: !!(steps && steps.length), proposal_generated: /```actions/.test(r) || (typeof chatActions === 'function' && chatActions(r).actions.length > 0), suggested_tasks_generated: /Suggested tasks:/i.test(r), reply_length: r.length };
}
const guardVariant = () => { const g = kinLoad(GUARD_KEY, {}); return GUARD_VARIANTS[g.variant] ? g.variant : GUARD_DEFAULT; };

/* Pasted conversation → messages. Lines starting "Diana:" are hers; "You:", "Me:", "Justin:" or "User:" are the user's.
 * If it ends with a Diana reply, that reply is dropped: the test regenerates it. */
function guardParse(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^\s*(diana|steward|assistant|you|me|user|justin)\s*:\s*(.*)$/i);
    if (m) out.push({ role: /^(diana|steward|assistant)$/i.test(m[1]) ? 'assistant' : 'user', content: m[2] });
    else if (out.length) out[out.length - 1].content += '\n' + line;
    else if (line.trim()) out.push({ role: 'user', content: line });
  }
  out.forEach((m) => { m.content = m.content.trim(); });
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  return out.filter((m) => m.content);
}

/* The A–D replay test. Same conversation, same model, same lookups; four guard versions, three runs each,
 * shown under shuffled letters until the user has judged them. Nothing here touches the real chat or memory. */
function ReplayTest({ state, plan, chat, setToast }) {
  const [raw, setRaw] = useState('');
  const [runs, setRuns] = useState(null); // { letters: {A: variant}, results: {variant: [{reply, ms, diag, meta}]}, fired }
  const [prog, setProg] = useState('');
  const [marks, setMarks] = useState({}); // 'A0' → true (moves forward), 'A-pushy' → true
  const [pick, setPick] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [, bump] = useState(0);
  const fromChat = () => setRaw(chat.filter((m) => !m.pending && m.content).slice(-12).map((m) => (m.role === 'assistant' ? 'Diana: ' : 'You: ') + m.content).join('\n'));
  const start = async () => {
    const conv = guardParse(raw);
    if (conv.length < 3 || conv[conv.length - 1].role !== 'user') { setToast({ text: 'Paste at least a few turns, ending with your message (lines starting “You:” and “Diana:”)', id: uid() }); return; }
    if (kinAI.status !== 'ready') { setToast({ text: 'Connect Diana first', id: uid() }); return; }
    const text = conv[conv.length - 1].content, prior = conv.slice(0, -1);
    const order = Object.keys(GUARD_VARIANTS).sort(() => Math.random() - 0.5);
    const letters = Object.fromEntries(order.map((v, i) => ['ABCD'[i], v]));
    const results = {};
    setRuns(null); setMarks({}); setPick(null); setRevealed(false);
    let n = 0;
    for (let rep = 0; rep < 3; rep++) for (const v of order) {
      n++; setProg('Running ' + n + ' of 12…');
      const refs = { ...snapshotRefs(state, Date.now()).map };
      const req = guardRequest({ msgs: prior, text, baseSystem: kinSystem(state, plan, text), variant: v, state, plan, refs });
      const t0 = Date.now();
      let r;
      try { r = await agentRun({ system: req.system, history: req.history, state, plan, refs }); } catch (e) { r = { text: '[Error: ' + e.message + ']', steps: [] }; }
      (results[v] = results[v] || []).push({ reply: r.text, ms: Date.now() - t0, diag: guardDiag(r.text, r.steps), meta: req.meta });
    }
    setProg('');
    setRuns({ letters, results, fired: results.guard[0].meta.guard_fired, depth: results.guard[0].meta.exploration_depth_before });
  };
  const verdict = () => {
    const avg = (v) => runs.results[v].reduce((a, x) => a + x.ms, 0) / 3;
    const base = avg('current');
    const out = {};
    for (const [L, v] of Object.entries(runs.letters)) {
      const fwd = [0, 1, 2].filter((i) => marks[L + i]).length;
      const q = runs.results[v].filter((x) => x.diag.ended_with_question).length;
      const pushy = !!marks[L + '-pushy'];
      const slow = avg(v) - base;
      out[v] = { letter: L, forward: fwd, ended_with_question: q, pushy, extra_seconds: Math.round(slow / 100) / 10, pass: fwd >= 2 && q <= 1 && !pushy && slow <= 5000 };
    }
    const winner = ['guard', 'guard_short', 'guard_near'].find((v) => out[v].pass) || null;
    return { out, winner };
  };
  const reveal = () => {
    const { out, winner } = verdict();
    setRevealed(true);
    if (typeof stewardEvents === 'object') stewardEvents.record('replay_test', { entity: 'diana', actor: 'user', data: { model: kinAI.model ? kinAI.model.name : null, guard_fired: runs.fired, depth: runs.depth, letters: runs.letters, picked: pick ? runs.letters[pick] : null, verdict: out, winner, runs: Object.fromEntries(Object.entries(runs.results).map(([v, rs]) => [v, rs.map((x) => ({ ms: x.ms, diag: x.diag, meta: x.meta, reply: x.reply.slice(0, 1500) }))])) } });
    kinSave(GUARD_KEY + '.last', { at: Date.now(), out, winner, picked: pick ? runs.letters[pick] : null });
  };
  const toggle = (k) => setMarks((m) => ({ ...m, [k]: !m[k] }));
  const current = guardVariant();
  const v = runs && revealed ? verdict() : null;
  return html`<section class="panel">
    <div class="ph"><h2>Test Diana</h2></div>
    <div style=${{ padding: '12px 16px' }}>
      <p class="small muted" style=${{ margin: '0 0 8px' }}>Paste a conversation where Diana went in circles, with lines starting “You:” and “Diana:”. End it with your message, or with the Diana reply you didn’t like (it gets regenerated). Diana answers it 12 times, in four versions labeled A to D. Nothing here changes your real chat or what she knows.</p>
      <textarea class="in" rows="8" value=${raw} onInput=${(e) => setRaw(e.target.value)} placeholder=${'You: I feel like I have no direction at work\nDiana: ...\nYou: yes exactly'} style=${{ width: '100%', fontFamily: 'inherit' }}></textarea>
      <div style=${{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button class="btn sm" onClick=${fromChat} disabled=${!chat.length}>Use my current chat</button>
        <button class="btn pri sm" onClick=${start} disabled=${!!prog || !raw.trim()}>Run the test</button>
        <span class="small muted">${prog || 'Takes a few minutes on your laptop.'}</span>
      </div>
    </div>
    ${runs ? html`<div style=${{ padding: '0 16px 16px' }}>
      ${!runs.fired ? html`<p class="small" style=${{ color: 'var(--warn,#b80)' }}>Heads up: this conversation didn’t have two questioning replies in a row at the end, so the reminder didn’t kick in and the versions differ only by chance.</p>` : null}
      <p class="small muted">For each reply, tick it if it moves things forward (a clear take, a concrete next step, or using what Steward knows). Tick “too pushy or cold” for a version that felt wrong. Then pick your favorite and press Reveal.</p>
      ${Object.entries(runs.letters).map(([L, variant]) => html`<div key=${L} style=${{ borderTop: '1px solid var(--line)', padding: '12px 0' }}>
        <div style=${{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <b>${L}</b>${revealed ? html`<span class="small">${GUARD_VARIANTS[variant]}</span><span class=${'small'} style=${{ color: v.out[variant].pass ? 'var(--ok,#2a7)' : 'var(--danger,#c33)' }}>${v.out[variant].pass ? 'passes' : 'doesn’t pass'}</span>` : null}
          <span style=${{ flex: 1 }}></span>
          <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!marks[L + '-pushy']} disabled=${revealed} onChange=${() => toggle(L + '-pushy')} />Too pushy or cold</label>
          <label class="small" style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="radio" name="pick" checked=${pick === L} disabled=${revealed} onChange=${() => setPick(L)} />Favorite</label>
        </div>
        ${runs.results[variant].map((x, i) => html`<div key=${i} style=${{ margin: '8px 0 0', padding: '8px 10px', background: 'var(--bg2, rgba(127,127,127,.08))', borderRadius: '8px' }}>
          <div style=${{ whiteSpace: 'pre-wrap' }}>${kinPlain(x.reply)}</div>
          <div class="small muted" style=${{ marginTop: '6px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label style=${{ display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" checked=${!!marks[L + i]} disabled=${revealed} onChange=${() => toggle(L + i)} />Moves forward</label>
            <span>${Math.round(x.ms / 1000)}s</span><span>${x.diag.question_count} question${x.diag.question_count === 1 ? '' : 's'}</span>
            ${x.diag.ended_with_question ? html`<span>ends with a question</span>` : null}${x.diag.tool_used ? html`<span>looked something up</span>` : null}
            ${x.diag.proposal_generated ? html`<span>proposed changes</span>` : null}${x.diag.suggested_tasks_generated ? html`<span>suggested tasks</span>` : null}<span>${x.diag.reply_length} chars</span>
          </div></div>`)}
      </div>`)}
      ${!revealed ? html`<button class="btn pri sm" onClick=${reveal}>Reveal which was which</button>` : html`<div style=${{ borderTop: '1px solid var(--line)', paddingTop: '12px' }}>
        <p style=${{ margin: '0 0 8px' }}>${v.winner ? 'Simplest version that passes: ' + GUARD_VARIANTS[v.winner] + '.' : 'No version passed. The loop needs more than a nudge, so it’s back to the design before building more.'}</p>
        <p class="small muted" style=${{ margin: '0 0 8px' }}>Diana now uses: ${GUARD_VARIANTS[current]}. The result was saved to your history.</p>
        ${v.winner && v.winner !== current ? html`<button class="btn pri sm" onClick=${() => { kinSave(GUARD_KEY, { variant: v.winner, at: Date.now() }); setToast({ text: 'Diana now uses: ' + GUARD_VARIANTS[v.winner], id: uid() }); bump((n) => n + 1); }}>Use ${GUARD_VARIANTS[v.winner]}</button>` : null}
      </div>`}
    </div>` : null}
  </section>`;
}
