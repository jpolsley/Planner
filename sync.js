/* Steward sync and calendars — both go through the user's own Space (see space/app.py).
 * Sync: the whole planner plus Steward's memory is one document on the Space, saved to a private
 * Hugging Face dataset. Each device pulls when opened or focused and pushes a few seconds after a change.
 * When two devices changed things at once, the lists are merged item by item: the newer edit wins,
 * and deletions are remembered (state.gone) so a deleted task doesn't come back. */
const SYNC_META_KEY = 'steward.sync.v1';
const SYNC_LISTS = ['tasks', 'projects', 'notes', 'events'];

const stewardSync = {
  meta: kinLoad(SYNC_META_KEY, { rev: 0, hash: '', last: 0 }),
  status: 'idle', error: '', subs: new Set(), busy: null,
  set(patch) { Object.assign(this, patch); this.subs.forEach((f) => f()); },
  saveMeta(patch) { this.meta = { ...this.meta, ...patch }; kinSave(SYNC_META_KEY, this.meta); this.subs.forEach((f) => f()); },
  on() { const sp = kinSpace(); return !!(sp && sp.url && sp.key && sp.sync !== false); },
  async req(method, body, keepalive) {
    const sp = kinSpace();
    let res;
    try {
      res = await fetch(sp.url + '/v1/sync', { method, keepalive, cache: 'no-store', headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw new Error('Couldn’t reach your Space. It may be asleep or starting up.'); }
    let data = null; try { data = await res.json(); } catch (e) {}
    if (res.status === 404) throw new Error('Your Space needs the newest app.py to sync.');
    if (res.status === 401) throw new Error('The Steward key doesn’t match your Space.');
    if (!res.ok && res.status !== 409) throw new Error((data && data.error) || 'Sync error ' + res.status);
    return { status: res.status, data };
  },
};

/* A quick fingerprint, so an unchanged planner isn't sent again. */
function syncHash(obj) {
  const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
    : JSON.stringify(v === undefined ? null : v));
  const s = canon(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return s.length + ':' + (h >>> 0).toString(36);
}

/* What gets synced: the planner (minus things each device rebuilds) and Steward's memory. */
function syncPayload(state) {
  const { plan, ...planner } = state;
  return {
    planner: { ...planner, events: state.events.filter((e) => !e.src), allday: undefined },
    memory: kinMem.items, memoryGone: kinMem.gone || {},
  };
}

/* Stamps changed items with `upd` and records deletions in `gone`. Used for every local edit. */
function syncStamp(prev, next) {
  if (!prev || next === prev) return next;
  const now = Date.now();
  let gone = next.gone || prev.gone || {};
  let changed = false;
  const out = { ...next };
  for (const k of SYNC_LISTS) {
    if (!next[k] || next[k] === prev[k]) continue;
    const before = new Set(prev[k] || []);
    const ids = new Set(next[k].map((x) => x.id));
    out[k] = next[k].map((x) => (before.has(x) || x.src ? x : { ...x, upd: now }));
    for (const x of prev[k] || []) if (!ids.has(x.id) && !x.src) { if (!changed) { gone = { ...gone }; changed = true; } gone[x.id] = now; }
    for (const id of ids) if (gone[id]) { if (!changed) { gone = { ...gone }; changed = true; } delete gone[id]; }
  }
  if (changed) {
    const cutoff = now - 90 * 864e5;
    for (const id of Object.keys(gone)) if (gone[id] < cutoff) delete gone[id];
  }
  out.gone = gone;
  if (next.settings !== prev.settings) out.settingsUpd = now;
  return out;
}

function mergeById(a, b, gone) {
  const map = new Map();
  for (const x of b || []) map.set(x.id, x);
  for (const x of a || []) { const y = map.get(x.id); if (!y || (x.upd || 0) >= (y.upd || 0)) map.set(x.id, x); }
  return [...map.values()].filter((x) => !gone[x.id] || (x.upd || 0) > gone[x.id]);
}

/* Merges two synced payloads. `mine` wins ties; the newer edit of each item wins otherwise. */
function syncMerge(mine, theirs) {
  const a = mine.planner, b = theirs.planner || {};
  const gone = { ...(b.gone || {}) };
  for (const [id, t] of Object.entries(a.gone || {})) gone[id] = Math.max(gone[id] || 0, t);
  const planner = { ...b, ...a, gone };
  for (const k of SYNC_LISTS) planner[k] = mergeById(a[k], b[k], gone);
  planner.settings = (a.settingsUpd || 0) >= (b.settingsUpd || 0) ? a.settings : b.settings;
  planner.settingsUpd = Math.max(a.settingsUpd || 0, b.settingsUpd || 0);
  planner.onboarded = a.onboarded || b.onboarded;
  const mg = { ...(theirs.memoryGone || {}), ...(mine.memoryGone || {}) };
  const memory = mergeById(mine.memory, theirs.memory, mg).sort((x, y) => (y.created || 0) - (x.created || 0));
  return { planner, memory, memoryGone: mg };
}

/* A device that has never synced and holds nothing of its own simply takes the synced planner. */
const syncIsEmpty = (p) => !p.onboarded || ![...(p.tasks || []), ...(p.projects || []), ...(p.notes || []), ...(p.events || [])].some((x) => !x.sample);

/* One sync round. getLocal() returns the current state; apply(payload) replaces it. */
async function syncNow(getLocal, apply, opts = {}) {
  if (!stewardSync.on()) return;
  if (stewardSync.busy) return stewardSync.busy;
  const run = async () => {
    stewardSync.set({ status: 'syncing' });
    try {
      let local = syncPayload(getLocal());
      let meta = stewardSync.meta;
      if (!opts.pushOnly) {
        const { data: remote } = await stewardSync.req('GET');
        if (remote.data && remote.rev !== meta.rev) {
          const untouched = syncHash(local) === meta.hash;
          const next = untouched || (!meta.rev && syncIsEmpty(local.planner)) ? remote.data : syncMerge(local, remote.data);
          apply(next);
          local = next;
          stewardSync.saveMeta({ rev: remote.rev, hash: syncHash(remote.data) });
          meta = stewardSync.meta;
        } else if (remote.data == null && meta.rev) stewardSync.saveMeta({ rev: 0 });
      }
      for (let tries = 0; tries < 3; tries++) {
        const hash = syncHash(local);
        if (hash === stewardSync.meta.hash) break;
        const { status, data } = await stewardSync.req('PUT', { base_rev: stewardSync.meta.rev, data: local }, opts.keepalive);
        if (status === 200) { stewardSync.saveMeta({ rev: data.rev, hash }); break; }
        const merged = syncMerge(local, data.data || {});
        apply(merged);
        local = merged;
        stewardSync.saveMeta({ rev: data.rev, hash: syncHash(data.data) });
      }
      stewardSync.saveMeta({ last: Date.now() });
      stewardSync.set({ status: 'idle', error: '' });
    } catch (e) {
      stewardSync.set({ status: 'error', error: e.message || String(e) });
    }
  };
  stewardSync.busy = run().finally(() => { stewardSync.busy = null; });
  return stewardSync.busy;
}

/* ---------- calendars ---------- */
/* Reads one calendar link through the Space. Returns timed events (they block time) and all-day ones (shown as notes on the day). */
async function fetchCalendar(cal, days = 28) {
  const sp = kinSpace();
  if (!sp || !sp.url) throw new Error('Connect your Space first (Assistant → Your Space).');
  let res;
  try {
    res = await fetch(sp.url + '/v1/calendar', { method: 'POST', headers: { Authorization: 'Bearer ' + sp.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: cal.url, days }) });
  } catch (e) { throw new Error('Couldn’t reach your Space.'); }
  let data = {}; try { data = await res.json(); } catch (e) {}
  if (res.status === 404) throw new Error('Your Space needs the newest app.py to read calendars.');
  if (!res.ok) throw new Error(data.error || 'Calendar error ' + res.status);
  const ms = (v) => (typeof v === 'number' ? v : new Date(v).getTime());
  const timed = [], allday = [];
  for (const e of data.events || []) {
    const start = ms(e.start), end = ms(e.end);
    if (!isFinite(start)) continue;
    const id = cal.id + ':' + e.uid + ':' + start;
    if (e.allDay) {
      for (let d = sod(start); d < (end || start + 1); d = addDays(d, 1)) allday.push({ id: id + ':' + d, title: e.title, day: d, src: cal.id });
    } else timed.push({ id, title: e.title, start, end: Math.max(end, start + 5 * 60000), kind: 'meeting', src: cal.id, location: e.location || '' });
  }
  return { name: data.name || '', timed, allday };
}
