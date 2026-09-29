/* Steward history (Layer 1): an append-only record of what happened, so Steward can later learn how the
 * user actually works. Three kinds of records, all in one envelope:
 *   - planner changes, found by comparing each state with the one before (generic field before/after),
 *     with named operations where the meaning matters (completed, reopened, session_started/stopped, block_locked);
 *   - plan snapshots: what the scheduler planned for today and tomorrow (the plan itself is never stored elsewhere);
 *   - Diana runs: the question, each lookup, what she proposed, and what the user decided, linked by one id.
 * Events queue in this browser and are sent to the Steward server, which appends them to data/events/. */
const EV_QUEUE_KEY = 'steward.events.queue.v1';
const EV_MAX_QUEUE = 5000;
const EV_LISTS = { tasks: 'task', projects: 'project', notes: 'note', events: 'meeting' };
const EV_SKIP = new Set(['upd', 'sessions', 'timer', 'locked', 'repeatedTo']); // covered by named events or bookkeeping
const evDevice = (() => { try { let d = localStorage.getItem('steward.device'); if (!d) { d = 'dev-' + uid().slice(0, 8); localStorage.setItem('steward.device', d); } return d; } catch (e) { return 'dev-unknown'; } })();

const stewardEvents = {
  queue: kinLoad(EV_QUEUE_KEY, []),
  sending: false,
  push(list) {
    if (!list.length) return;
    this.queue = [...this.queue, ...list].slice(-EV_MAX_QUEUE);
    kinSave(EV_QUEUE_KEY, this.queue);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 3000);
  },
  record(op, fields) { this.push([evMake(op, fields)]); },
  async flush() {
    const sp = kinSpace();
    if (this.sending || !this.queue.length || !sp || !sp.url || !sp.key) return;
    this.sending = true;
    const batch = this.queue.slice(0, 500);
    try {
      const res = await fetch(sp.url + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
      if (res.ok) {
        const sent = new Set(batch.map((e) => e.id));
        this.queue = this.queue.filter((e) => !sent.has(e.id));
        kinSave(EV_QUEUE_KEY, this.queue);
        if (this.queue.length) setTimeout(() => this.flush(), 500);
      }
    } catch (e) { /* offline: keep the queue */ }
    finally { this.sending = false; }
  },
};

/* Per-device sequence number: orders this device's events even if clocks drift or uploads arrive late. */
let evCtx = null; // set while evDiff runs: every event from one change shares its commit id
let evSeq = (() => { try { return +localStorage.getItem('steward.device.seq') || 0; } catch (e) { return 0; } })();
const SCHEDULER_VERSION = 1; // bump when runSchedule's behavior changes, so old plan snapshots stay interpretable

function evMake(op, { entity = null, entity_id = null, actor = 'user', changes, corr, commit, proposal, data } = {}) {
  if (evCtx) { commit = commit || evCtx.commit; proposal = proposal || evCtx.proposal; }
  evSeq += 1;
  try { localStorage.setItem('steward.device.seq', String(evSeq)); } catch (e) {}
  const e = { id: uid() + uid(), ts: Date.now(), device: evDevice, seq: evSeq, actor, op, entity, entity_id };
  if (changes && changes.length) e.changes = changes;
  if (corr) e.corr = corr;            // trace id: one Diana run (or 'undo')
  if (proposal) e.proposal = proposal; // the proposal a decision or change came from
  if (commit) e.commit = commit;       // groups the field-level events of one change
  if (data) e.data = data;
  return e;
}

/* Keeps values small: long text becomes its length, objects are summarized. */
function evVal(v) {
  if (typeof v === 'string') return v.length > 200 ? { text_len: v.length } : v;
  if (Array.isArray(v)) return v.length > 20 ? { count: v.length } : v.map(evVal);
  if (v && typeof v === 'object') return JSON.stringify(v).length > 400 ? { keys: Object.keys(v).length } : v;
  return v === undefined ? null : v;
}
const evSame = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/* Compares two planner states and returns what changed. Imported calendar events (src) are skipped:
 * they are rebuilt from the calendar, not decided by the user. */
function evDiff(prev, next, actor, corr, proposal) {
  const out = [];
  evCtx = { commit: 'c-' + uid(), proposal };
  for (const [list, entity] of Object.entries(EV_LISTS)) {
    const a = prev[list] || [], b = next[list] || [];
    if (a === b) continue;
    const before = new Map(a.filter((x) => !x.src && !x.sample).map((x) => [x.id, x]));
    const seen = new Set();
    for (const x of b) {
      if (x.src || x.sample) continue;
      seen.add(x.id);
      const old = before.get(x.id);
      if (!old) { out.push(evMake('created', { entity, entity_id: x.id, actor, corr, data: evSnapshot(entity, x) })); continue; }
      if (old === x) continue;
      const changes = [];
      for (const f of new Set([...Object.keys(old), ...Object.keys(x)])) {
        if (EV_SKIP.has(f) || evSame(old[f], x[f])) continue;
        if (entity === 'task' && f === 'status') {
          const op = x.status === 'done' ? 'completed' : old.status === 'done' ? 'reopened' : null;
          if (op) { out.push(evMake(op, { entity, entity_id: x.id, actor, corr, data: { from: old.status, to: x.status, spent: x.spent || 0, estimate: x.duration, deadline: x.deadline || null } })); continue; }
        }
        if (entity === 'task' && f === 'completed') continue; // part of completed/reopened
        changes.push({ f, b: evVal(old[f]), a: evVal(x[f]) });
      }
      if (entity === 'task') {
        if (!old.timer && x.timer) out.push(evMake('session_started', { entity, entity_id: x.id, actor, corr, data: { at: x.timer } }));
        if (old.timer && !x.timer) { const s = (x.sessions || []).slice(-1)[0]; out.push(evMake('session_stopped', { entity, entity_id: x.id, actor, corr, data: s ? { start: s.s, end: s.e, minutes: Math.round((s.e - s.s) / 60000) } : {} })); }
        const oldLocks = new Set((old.locked || []).map((l) => l.id));
        for (const l of x.locked || []) if (!oldLocks.has(l.id)) out.push(evMake('block_locked', { entity, entity_id: x.id, actor, corr, data: { start: l.start, end: l.end } }));
      }
      if (changes.length) out.push(evMake('updated', { entity, entity_id: x.id, actor, corr, changes }));
    }
    for (const [id, x] of before) if (!seen.has(id)) out.push(evMake('deleted', { entity, entity_id: id, actor, corr, data: { title: x.title || x.name || null } }));
  }
  if (!evSame(prev.settings, next.settings) && prev.settings && next.settings) {
    const changes = Object.keys({ ...prev.settings, ...next.settings }).filter((f) => !evSame(prev.settings[f], next.settings[f])).map((f) => ({ f, b: evVal(prev.settings[f]), a: evVal(next.settings[f]) }));
    if (changes.length) out.push(evMake('updated', { entity: 'settings', actor, corr, changes }));
  }
  evCtx = null;
  return out;
}
function evSnapshot(entity, x) {
  if (entity === 'task') return { title: x.title, estimate: x.duration, priority: x.priority, deadline: x.deadline || null, hard: !!x.hard, projectId: x.projectId || null, stage: x.stage || null, status: x.status, startDate: x.startDate || null, repeat: x.repeat || null, labels: x.labels || [] };
  if (entity === 'project') return { name: x.name, deadline: x.deadline || null, status: x.status || null, stages: x.stages || [] };
  if (entity === 'meeting') return { title: x.title, start: x.start, end: x.end };
  return { title: x.title };
}

/* What the scheduler planned: today and tomorrow, recorded when it changes (and at least once a day). */
function evPlanSnapshot(plan, state, now) {
  const from = sod(now), to = addDays(from, 2);
  const blocks = plan.blocks.filter((b) => b.end > from && b.start < to).map((b) => [b.taskId, b.start, b.end, b.locked ? 1 : 0]);
  const late = Object.entries(plan.info || {}).filter(([, i]) => i.late).map(([id]) => id);
  const unplaced = Object.entries(plan.info || {}).filter(([, i]) => i.unscheduled).map(([id]) => id);
  const sig = syncHash({ blocks, late, unplaced });
  const input = syncHash({ t: state.tasks.filter((t) => t.status !== 'done').map((t) => [t.id, t.duration, t.spent, t.deadline, t.priority, t.startDate, t.deps, t.locked]), e: state.events.map((x) => [x.start, x.end]), s: state.settings });
  const last = kinLoad('steward.plansnap.v1', {});
  if (last.sig === sig && last.day === from) return;
  kinSave('steward.plansnap.v1', { sig, day: from });
  stewardEvents.record('plan_snapshot', { entity: 'plan', actor: 'scheduler', data: { day: from, scheduler_version: SCHEDULER_VERSION, plan_hash: sig, input_hash: input, blocks, late, unplaced, open: state.tasks.filter((t) => t.status !== 'done').length } });
}
