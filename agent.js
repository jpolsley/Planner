/* Steward's agent loop: the chat model can look things up with read-only tools before it answers,
 * then propose changes (the ```actions block, see assistant.js). Patterns follow open-claude-code's
 * design: a bounded tool loop, permission modes for changes, and compacting long conversations.
 * Tools never change anything; changes always go through the actions block and the permission mode. */
const AGENT_MAX_STEPS = 4;
const AGENT_MODES = {
  ask: { label: 'Ask every time', hint: 'Diana shows each change and waits for Apply.' },
  auto: { label: 'Auto for small changes', hint: 'Adding, rescheduling and reprioritizing happen right away (you can undo). Finishing or deleting still asks.' },
  plan: { label: 'Plan only', hint: 'Diana suggests but never changes your planner.' },
};
const AGENT_SMALL = new Set(['add', 'update', 'meeting', 'move_meeting']);

const AGENT_TOOLS_PROMPT = '\n\nBefore answering you may look things up. To use a tool, reply with ONLY a block like:\n```tool\n{"name":"search_tasks","args":{"query":"budget"}}\n```\nand nothing else; you will get the result and can use another tool (at most ' + AGENT_MAX_STEPS + ' in total) or answer. Tools:\n'
  + '- search_tasks {query?, status?: "open"|"done"|"blocked"|"doing", project?, due_within_days?}: matching tasks with T# refs, estimates, deadlines, schedule.\n'
  + '- project_status {name}: a project\'s progress, stages, risk, open tasks.\n'
  + '- free_time {from: "YYYY-MM-DD", days?: 1-14, minutes?: 30}: open slots in working hours not taken by meetings or scheduled work.\n'
  + '- read_note {query}: the most relevant note (meeting notes, logs, reviews).\n'
  + '- past_conversations {query}: summaries of earlier chats.\n'
  + '- calendar {from: "YYYY-MM-DD", days?: 1-14}: meetings with M# refs.\n'
  + 'Use tools only when the snapshot is not enough. Never show tool blocks to the user in a final answer.';

function agentTool(name, args, state, plan, refs) {
  const now = Date.now();
  const ref = (kind, id) => { const hit = Object.entries(refs).find(([, v]) => v === id); if (hit) return hit[0]; const n = Object.keys(refs).filter((k) => k[0] === kind).length + 1; refs[kind + n] = id; return kind + n; };
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)).getTime() : sod(now));
  const proj = (t) => (state.projects.find((p) => p.id === t.projectId) || {}).name;
  const line = (t) => '[' + ref('T', t.id) + '] ' + t.title + ' — ' + ({ todo: 'to do', doing: 'in progress', blocked: 'blocked', done: 'done' }[t.status] || t.status) + ', ' + PRI_LABEL[t.priority] + ', ' + fmtDur(remainingMin(t)) + ' left'
    + (t.deadline ? ', due ' + fmtD(t.deadline) : '') + (proj(t) ? ', project ' + proj(t) : '') + ((plan.info[t.id] || {}).first && t.status !== 'done' ? ', scheduled ' + fmtD(plan.info[t.id].first) + ' ' + fmtT(plan.info[t.id].first) : '')
    + (t.completed ? ', finished ' + fmtD(t.completed) : '') + ((t.labels || []).length ? ', labels ' + t.labels.join('/') : '');
  args = args || {};
  if (name === 'search_tasks') {
    const q = String(args.query || '').toLowerCase();
    let ts = state.tasks;
    if (args.status === 'open') ts = ts.filter((t) => t.status !== 'done');
    else if (args.status) ts = ts.filter((t) => t.status === args.status);
    else if (!q) ts = ts.filter((t) => t.status !== 'done');
    if (args.project) ts = ts.filter((t) => (proj(t) || '').toLowerCase().includes(String(args.project).toLowerCase()));
    if (args.due_within_days) ts = ts.filter((t) => t.deadline && t.deadline < addDays(sod(now), +args.due_within_days + 1));
    if (q) ts = ts.map((t) => ({ t, s: kinOverlap(q, t.title + ' ' + (t.desc || '') + ' ' + (t.labels || []).join(' ') + ' ' + (proj(t) || '')) + (t.title.toLowerCase().includes(q) ? 1 : 0) })).filter((x) => x.s > 0.1).sort((a, b) => b.s - a.s).map((x) => x.t);
    return ts.length ? ts.slice(0, 25).map(line).join('\n') : 'No matching tasks.';
  }
  if (name === 'project_status') {
    const n = String(args.name || '').toLowerCase();
    const p = state.projects.find((x) => x.name.toLowerCase() === n) || state.projects.map((x) => ({ x, s: kinOverlap(n, x.name + ' ' + (x.desc || '')) })).sort((a, b) => b.s - a.s).filter((y) => y.s > 0)[0]?.x;
    if (!p) return 'No project like that. Projects: ' + state.projects.map((x) => x.name).join('; ');
    const ts = state.tasks.filter((t) => t.projectId === p.id);
    const end = Math.max(0, ...ts.filter((t) => t.status !== 'done').map((t) => (plan.info[t.id] || {}).end || 0));
    return p.name + (p.desc ? ': ' + p.desc.slice(0, 300) : '') + '\nStatus ' + (P_STATUS[p.status] || p.status) + (p.deadline ? ', deadline ' + fmtD(p.deadline) : '') + ', ' + ts.filter((t) => t.status === 'done').length + '/' + ts.length + ' done'
      + (end ? ', projected finish ' + fmtD(end) + (p.deadline && end > p.deadline ? ' (AT RISK: after the deadline)' : '') : '') + '\nTasks:\n' + ts.map(line).join('\n');
  }
  if (name === 'free_time') {
    const from = day(args.from), days = Math.max(1, Math.min(14, +args.days || 1)), need = Math.max(15, +args.minutes || 30);
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i), h = state.settings.hours[new Date(d).getDay()];
      if (!h) continue;
      const busy = [...state.events.map((e) => [e.start, e.end]), ...plan.blocks.map((b) => [b.start, b.end]), ...state.settings.breaks.map((b) => [atMin(d, b.s), atMin(d, b.e)])].filter(([s, e]) => e > atMin(d, h[0]) && s < atMin(d, h[1])).sort((a, b) => a[0] - b[0]);
      let t = Math.max(atMin(d, h[0]), now);
      const slots = [];
      for (const [s, e] of [...busy, [atMin(d, h[1]), atMin(d, h[1])]]) { if (s - t >= need * MIN) slots.push(fmtT(t) + '–' + fmtT(s)); t = Math.max(t, e); }
      out.push(fmtD(d) + ': ' + (slots.length ? slots.join(', ') : 'no open slot of ' + fmtDur(need)));
    }
    return (out.join('\n') || 'No working days in that range.') + '\n(Scheduled work blocks are flexible; Steward reflows them around new meetings.)';
  }
  if (name === 'read_note') {
    const q = String(args.query || '');
    const n = state.notes.map((x) => ({ x, s: kinOverlap(q, x.title + ' ' + x.body.slice(0, 3000)) + (x.title.toLowerCase().includes(q.toLowerCase()) ? 1 : 0) })).sort((a, b) => b.s - a.s)[0];
    return n && n.s > 0.05 ? n.x.title + ' (updated ' + fmtD(n.x.updated) + '):\n' + n.x.body.slice(0, 3000) : 'No matching note. Notes: ' + state.notes.slice(0, 20).map((x) => x.title).join('; ');
  }
  if (name === 'past_conversations') {
    const c = typeof recallConvos === 'function' ? recallConvos(state, String(args.query || ''), 5) : [];
    return c.length ? c.map((x) => fmtD(x.at) + ' — ' + x.topic + ': ' + x.points.join(' ')).join('\n') : 'No earlier conversation about that.';
  }
  if (name === 'calendar') {
    const from = day(args.from), to = addDays(from, Math.max(1, Math.min(14, +args.days || 7)));
    const evs = state.events.filter((e) => e.start >= from && e.start < to).sort((a, b) => a.start - b.start);
    return evs.length ? evs.map((e) => '[' + ref('M', e.id) + '] ' + e.title + ' ' + fmtD(e.start) + ' ' + fmtT(e.start) + '–' + fmtT(e.end) + (e.src ? ' (from their calendar, read-only)' : '')).join('\n') : 'No meetings in that range.';
  }
  return 'Unknown tool "' + name + '".';
}

function agentToolCall(text) {
  const m = String(text).match(/```\s*tool\s*\n?([\s\S]*?)```/i);
  if (!m) return null;
  try { const j = JSON.parse(m[1].trim()); return j && j.name ? { name: String(j.name), args: j.args || {} } : null; } catch (e) { return { name: 'invalid', args: {}, bad: m[1].slice(0, 200) }; }
}
const AGENT_TOOL_LABEL = { search_tasks: 'Searching tasks', project_status: 'Checking the project', free_time: 'Finding free time', read_note: 'Reading notes', past_conversations: 'Remembering earlier chats', calendar: 'Checking the calendar' };

/* Runs the loop. onStep(steps) reports each lookup; onText(textSoFar) streams the answer. Returns { text, steps }. */
async function agentRun({ system, history, state, plan, refs, onStep, onText, maxTokens = 700 }) {
  // Parts that never change go first so a local model can reuse what it already read (prompt caching);
  // the planner snapshot, recall and time come after.
  const content = system.startsWith(KIN_BASE) ? KIN_BASE + AGENT_TOOLS_PROMPT + system.slice(KIN_BASE.length) : system + AGENT_TOOLS_PROMPT;
  const msgs = [{ role: 'system', content }, ...history];
  const steps = [];
  for (let i = 0; i <= AGENT_MAX_STEPS; i++) {
    let streamed = '';
    // Show the text only once it's clear this turn is an answer, not a tool call.
    const out = await kinAI.ask({ messages: msgs, baseSystem: system, maxTokens, onChunk: (c) => {
      streamed += c;
      const t = streamed.trimStart();
      if (t.length >= 4 && !t.startsWith('`') && !/```\s*tool/i.test(streamed)) onText && onText(streamed);
    } });
    const call = i < AGENT_MAX_STEPS ? agentToolCall(out) : null;
    if (!call) return { text: out.replace(/```\s*tool[\s\S]*?```/gi, '').trim(), steps };
    steps.push({ tool: call.name, args: call.args });
    onStep && onStep(steps);
    const result = call.bad ? 'That tool block was not valid JSON: ' + call.bad : agentTool(call.name, call.args, state, plan, refs);
    // Evidence for the decision trace: a short summary and fingerprint of what Diana saw, not a second copy of the data.
    steps[steps.length - 1].obs = { chars: result.length, lines: result.split('\n').length, hash: syncHash(result), head: result.split('\n')[0].slice(0, 160) };
    msgs.push({ role: 'assistant', content: out.trim() }, { role: 'user', content: 'Tool result (' + call.name + '):\n' + result.slice(0, 6000) + '\n\nContinue: use another tool if needed, or answer the user now.' });
  }
  return { text: '', steps };
}
