/* Steward's learning loop (ideas from Nous Research's Hermes agent, rebuilt for the browser):
 * 1. Playbooks: when a project is finished, Steward writes down how you ran it; similar projects are planned from it,
 *    and the playbook is revised each time it's used again.
 * 2. Memory tidying: merges duplicate facts, drops stale ones, and asks about contradictions.
 * 3. Past conversations: chats are summarized and recalled when a later question touches the same topic.
 * All of it lives in the planner state (state.playbooks, state.convos), so it syncs and can be edited. */
const kinOverlap = (a, b) => { const x = kinTerms(a), y = kinTerms(b); let n = 0; x.forEach((t) => { if (y.has(t)) n++; }); return x.size && y.size ? n / Math.sqrt(x.size * y.size) : 0; };

/* ---------- 1. playbooks ---------- */
function findPlaybook(state, text) {
  const best = (state.playbooks || []).map((p) => ({ p, s: kinOverlap(text, p.title + ' ' + (p.tags || []).join(' ') + ' ' + p.body.slice(0, 600)) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 0.18 ? best.p : null;
}
/* Everything the planner saw while the project ran: stages, estimates vs tracked time, slips, notes. */
function projectDebrief(p, state) {
  const ts = state.tasks.filter((t) => t.projectId === p.id);
  const stages = [...new Set(ts.map((t) => t.stage || 'Tasks'))];
  const lines = ['Project: ' + p.name + (p.desc ? ' — ' + p.desc.slice(0, 400) : '')];
  if (p.start || p.created) lines.push('Ran from ' + fmtD(p.start || p.created) + ' to ' + fmtD(Math.max(...ts.map((t) => t.completed || 0), Date.now())) + (p.deadline ? ', deadline ' + fmtD(p.deadline) : '') + '.');
  for (const st of stages) {
    lines.push('Stage ' + st + ':');
    for (const t of ts.filter((x) => (x.stage || 'Tasks') === st)) {
      lines.push('- ' + t.title + ': estimated ' + fmtDur(t.duration || 30) + (t.spent >= 1 ? ', tracked ' + fmtDur(t.spent) : '') + (t.status !== 'done' ? ', not finished' : t.deadline && t.completed > t.deadline ? ', finished ' + Math.round((t.completed - t.deadline) / 864e5) + ' days late' : '') + ((t.checklist || []).length ? ' (steps: ' + t.checklist.map((c) => c.text).join('; ').slice(0, 200) + ')' : ''));
    }
  }
  const notes = state.notes.filter((n) => n.projectId === p.id).map((n) => n.title + ': ' + n.body.replace(/## Transcript[\s\S]*/, '').slice(0, 700));
  if (notes.length) lines.push('Notes:\n' + notes.join('\n---\n').slice(0, 2500));
  return lines.join('\n');
}
async function kinWritePlaybook(p, state) {
  await kinReady();
  const existing = findPlaybook(state, p.name + ' ' + (p.desc || ''));
  const sys = 'You write short, practical playbooks from how a person actually ran a project, so the next similar project goes better. Be specific to what happened; never invent.';
  const user = 'What happened:\n' + projectDebrief(p, state) + '\n\n'
    + (existing ? 'Their existing playbook "' + existing.title + '" (revise it with what this project taught; keep what still holds):\n' + existing.body + '\n\n' : '')
    + 'Write the playbook in markdown with these sections: "## When to use" (one line), "## Stages" (ordered, with the key tasks and realistic durations based on tracked time), "## Watch out for" (what slipped or took longer), "## Next time" (2-4 concrete improvements). Under 250 words. First line: "TITLE: <short name like Youth retreat>". Second line: "TAGS: <3-6 comma-separated keywords>".';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 700, temperature: 0.3, docs: false });
  const title = (out.match(/^\s*TITLE:\s*(.+)$/im) || [])[1] || p.name;
  const tags = ((out.match(/^\s*TAGS:\s*(.+)$/im) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const body = out.replace(/^\s*(TITLE|TAGS):.*$/gim, '').trim();
  return { id: existing ? existing.id : uid(), title: title.trim().slice(0, 80), tags, body, uses: existing ? existing.uses || 0 : 0, from: [...new Set([...(existing ? existing.from || [] : []), p.name])], created: existing ? existing.created : Date.now(), updated: Date.now(), revised: !!existing };
}

/* ---------- 2. memory tidying ---------- */
async function kinTidyMemory() {
  await kinReady();
  const items = kinMem.items.slice(0, 120);
  if (items.length < 4) return { merge: [], remove: [], ask: [] };
  const list = items.map((m, i) => (i + 1) + '. ' + m.text + ' (' + fmtD(m.created) + ')').join('\n');
  const sys = 'You maintain a list of facts an assistant knows about its user. Reply with ONLY JSON.';
  const user = 'Facts:\n' + list + '\n\nReturn {"merge":[{"ids":[numbers],"text":"one combined fact starting with You"}],"remove":[{"id":number,"why":"short reason"}],"ask":[{"ids":[numbers],"question":"short question to the user"}]}. '
    + 'merge: facts that say the same thing or belong together. remove: facts that are clearly outdated, trivial, or one-off rather than lasting. ask: facts that contradict each other. Be conservative; empty lists are fine.';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 700, temperature: 0, docs: false });
  const j = kinJSON(out);
  const id = (n) => items[+n - 1] && items[+n - 1].id;
  return {
    merge: (j.merge || []).map((m) => ({ ids: (m.ids || []).map(id).filter(Boolean), text: String(m.text || '').trim() })).filter((m) => m.ids.length > 1 && m.text),
    remove: (j.remove || []).map((r) => ({ id: id(r.id), why: String(r.why || '') })).filter((r) => r.id),
    ask: (j.ask || []).map((q) => ({ ids: (q.ids || []).map(id).filter(Boolean), question: String(q.question || '') })).filter((q) => q.ids.length && q.question),
  };
}

/* ---------- 3. past conversations ---------- */
async function kinSummarizeChat(msgs) {
  await kinReady();
  const text = msgs.map((m) => (m.role === 'user' ? 'User: ' : 'Steward: ') + String(m.content).replace(/```actions[\s\S]*?```/g, '').slice(0, 1200)).join('\n').slice(-9000);
  const sys = 'You summarize a conversation between a user and their planning assistant so it can be recalled months later.';
  const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Conversation:\n' + text + '\n\nWrite: first line "TOPIC: <3-8 words>", then 2-5 bullets starting with "- " covering what was discussed, decided, or planned, with names and dates as stated. Skip small talk.' }], baseSystem: sys, maxTokens: 260, temperature: 0.2, docs: false });
  const topic = ((out.match(/^\s*TOPIC:\s*(.+)$/im) || [])[1] || 'Conversation').trim().slice(0, 80);
  const points = out.split('\n').map((l) => l.match(/^\s*[-*•]\s+(.{3,300})$/)).filter(Boolean).map((m) => m[1].trim()).slice(0, 5);
  return points.length ? { id: uid(), at: msgs[0].at || Date.now(), topic, points } : null;
}
function recallConvos(state, text, limit = 3) {
  return (state.convos || []).map((c) => ({ c, s: kinOverlap(text, c.topic + ' ' + c.points.join(' ')) })).filter((x) => x.s >= 0.15).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.c);
}

/* ---------- UI (shown under Assistant → What I know) ---------- */
function LearningPanels({ state, commit, setToast }) {
  const [open, setOpen] = useState(null);
  const [tidy, setTidy] = useState(null);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({});
  const pbs = (state.playbooks || []).slice().sort((a, b) => b.updated - a.updated);
  const convos = (state.convos || []).slice().sort((a, b) => b.at - a.at);
  const setPb = (id, patch) => commit((s) => ({ ...s, playbooks: (s.playbooks || []).map((p) => (p.id === id ? { ...p, ...patch, updated: Date.now() } : p)) }));
  const lastTidy = state.memTidied || 0;
  const runTidy = async () => {
    setBusy(true);
    try { const r = await kinTidyMemory(); setTidy(r); if (!r.merge.length && !r.remove.length && !r.ask.length) { setToast({ text: 'Memory is already tidy', id: uid() }); commit((s) => ({ ...s, memTidied: Date.now() })); setTidy(null); } }
    catch (e) { setToast({ text: 'Tidying failed: ' + (e.message || e), id: uid() }); }
    finally { setBusy(false); }
  };
  const applyTidy = () => {
    const text = (id) => (kinMem.items.find((m) => m.id === id) || {}).text || '';
    tidy.merge.forEach((m) => { m.ids.forEach((id) => kinMem.remove(id)); kinMem.add(m.text, 'tidy'); });
    tidy.remove.forEach((r) => kinMem.remove(r.id));
    tidy.ask.forEach((q, i) => { const a = (answers[i] || '').trim(); if (a) { q.ids.forEach((id) => kinMem.remove(id)); kinMem.add(a.replace(/^i\b/i, 'You').replace(/\bmy\b/gi, 'your'), 'you'); } });
    commit((s) => ({ ...s, memTidied: Date.now() }));
    setTidy(null); setAnswers({});
    setToast({ text: 'Memory tidied', id: uid() });
    void text;
  };
  const memText = (id) => (kinMem.items.find((m) => m.id === id) || {}).text || '(already gone)';
  const aiOn = typeof kinAIAvailable === 'function' && kinAIAvailable();
  return html`<div>
    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div class="ph"><h2>Tidy memory</h2><span class="grow"></span>${aiOn ? html`<button class="btn sm" disabled=${busy || kinMem.items.length < 4} onClick=${runTidy}><${Icon} n="spark" />${busy ? 'Reviewing…' : 'Tidy now'}</button>` : null}</div>
      ${!tidy ? html`<p class="muted small" style=${{ padding: '0 16px 14px', margin: 0 }}>${lastTidy ? 'Last tidied ' + relD(lastTidy, Date.now()).toLowerCase() + '. ' : ''}Steward merges repeated facts, drops outdated ones, and asks you when two facts disagree. Nothing changes until you apply it.${!lastTidy || Date.now() - lastTidy > 7 * 864e5 ? (kinMem.items.length >= 12 ? ' It’s a good time for a tidy.' : '') : ''}</p>` : html`<div style=${{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13.5px' }}>
        ${tidy.merge.map((m, i) => html`<div key=${'m' + i}><b>Combine</b> ${m.ids.map(memText).map((t) => '“' + t + '”').join(' + ')}<br/><span class="muted">→ ${m.text}</span></div>`)}
        ${tidy.remove.map((r, i) => html`<div key=${'r' + i}><b>Forget</b> “${memText(r.id)}” <span class="muted">· ${r.why}</span></div>`)}
        ${tidy.ask.map((q, i) => html`<div key=${'q' + i}><b>${q.question}</b><div class="muted small">${q.ids.map(memText).join(' / ')}</div><input class="in" style=${{ marginTop: '4px' }} value=${answers[i] || ''} onInput=${(e) => setAnswers({ ...answers, [i]: e.target.value })} placeholder="Your answer replaces those facts (optional)" /></div>`)}
        <div style=${{ display: 'flex', gap: '6px' }}><button class="btn sm pri" onClick=${applyTidy}>Apply</button><button class="btn sm ghost" onClick=${() => setTidy(null)}>Cancel</button></div>
      </div>`}
    </section>

    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div class="ph"><h2>Playbooks · ${pbs.length}</h2></div>
      ${!pbs.length ? html`<p class="muted small" style=${{ padding: '0 16px 14px', margin: 0 }}>When you finish a project, Steward offers to write down how it went: the stages, real durations, and what to do differently. Similar projects are then planned from it, and it improves each time.</p>` : null}
      ${pbs.map((p) => html`<div key=${p.id} style=${{ borderTop: '1px solid var(--line)', padding: '10px 16px' }}>
        <div style=${{ display: 'flex', gap: '8px', alignItems: 'center' }}><button class="tt" style=${{ flex: 1, textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'var(--ink)' }} onClick=${() => setOpen(open === p.id ? null : p.id)}><b>${p.title}</b> <span class="muted small">· from ${(p.from || []).join(', ')} · used ${p.uses || 0}×</span></button>
          <button class="btn sm ghost" onClick=${() => setOpen(open === p.id ? null : p.id)}>${open === p.id ? 'Close' : 'Open'}</button>
          <button class="btn sm ghost danger" onClick=${() => commit((s) => ({ ...s, playbooks: (s.playbooks || []).filter((x) => x.id !== p.id) }), 'Playbook deleted')}>Delete</button></div>
        ${open === p.id ? html`<textarea class="in" style=${{ marginTop: '8px', minHeight: '220px' }} value=${p.body} onInput=${(e) => setPb(p.id, { body: e.target.value })} aria-label="Playbook"></textarea>` : null}
      </div>`)}
    </section>

    <section class="panel" style=${{ marginBottom: '16px' }}>
      <div class="ph"><h2>Past conversations · ${convos.length}</h2></div>
      ${!convos.length ? html`<p class="muted small" style=${{ padding: '0 16px 14px', margin: 0 }}>After a chat, Steward keeps a short summary so it can recall it later, like “what did we decide about the volunteer schedule?”</p>` : null}
      ${convos.slice(0, 30).map((c) => html`<div key=${c.id} style=${{ borderTop: '1px solid var(--line)', padding: '10px 16px', display: 'flex', gap: '8px' }}>
        <div style=${{ flex: 1 }}><b>${c.topic}</b> <span class="muted small">· ${fmtD(c.at)}</span>${c.points.map((x, i) => html`<div key=${i} class="small muted">• ${x}</div>`)}</div>
        <button class="btn sm ghost" onClick=${() => commit((s) => ({ ...s, convos: (s.convos || []).filter((x) => x.id !== c.id) }))} aria-label="Forget this conversation">Forget</button>
      </div>`)}
    </section>
  </div>`;
}

/* Offered on a finished project's page. */
function PlaybookOffer({ p, state, commit, setToast }) {
  const [busy, setBusy] = useState(false);
  const ts = state.tasks.filter((t) => t.projectId === p.id);
  const finished = p.status === 'done' || (ts.length >= 3 && ts.every((t) => t.status === 'done'));
  if (!finished || p.playbook || !(typeof kinAIAvailable === 'function' && kinAIAvailable())) return null;
  const write = async () => {
    setBusy(true);
    try {
      const pb = await kinWritePlaybook(p, state);
      commit((s) => ({ ...s, playbooks: [...(s.playbooks || []).filter((x) => x.id !== pb.id), pb], projects: s.projects.map((x) => (x.id === p.id ? { ...x, playbook: pb.id } : x)) }), pb.revised ? 'Playbook “' + pb.title + '” updated' : 'Playbook “' + pb.title + '” saved');
    } catch (e) { setToast({ text: 'Couldn’t write the playbook: ' + (e.message || e), id: uid() }); }
    finally { setBusy(false); }
  };
  return html`<div class="rit" style=${{ marginBottom: '14px' }}><div class="rit-h"><span class="eyebrow">Project finished</span><b>Save what you learned as a playbook?</b><span class="muted small">Steward writes down the stages, real durations and what to do differently, and plans similar projects from it.</span></div>
    <div class="acts"><button class="btn sm pri" disabled=${busy} onClick=${write}><${Icon} n="spark" />${busy ? 'Writing…' : 'Write playbook'}</button><button class="btn sm ghost" onClick=${() => commit((s) => ({ ...s, projects: s.projects.map((x) => (x.id === p.id ? { ...x, playbook: 'skipped' } : x)) }))}>No thanks</button></div></div>`;
}
