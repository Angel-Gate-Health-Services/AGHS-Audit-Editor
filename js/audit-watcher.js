export const SITE_BUSY_MESSAGE = 'This site is already being audited';

// Polling keeps the picker current; an atomic server claim is the authority.
// Reservations expire if heartbeats stop, so a closed tab cannot block a site forever.
export function createAuditWatcher({ api, onChange = () => {}, onLost = () => {},
  now = Date.now, makeId = () => crypto.randomUUID(),
  schedule = (fn) => setInterval(fn, 5000), cancel = clearInterval }) {
  let target = null;
  let held = null;
  let status = 'idle';
  let error = '';
  let list = [];
  let loaded = false;
  let watching = false;
  let stopped = false;
  let generation = 0;
  let queue = Promise.resolve();
  let opening = null;
  let refreshing = null;
  let renewedAt = 0;
  const same = (a, b) => a?.homeId === b?.homeId && a?.auditId === b?.auditId;
  const notify = () => onChange();
  const release = (lease) => lease ? api.releaseAuditSite(lease).catch(() => {}) : Promise.resolve();
  const activeList = () => list.filter((r) => Date.parse(r.expires_at) > now());

  async function refresh() {
    if (stopped || (!watching && !target)) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        if (held && now() - renewedAt >= 20000) {
          const lease = held;
          const record = await api.renewAuditSite(lease);
          if (held === lease) {
            if (!record) {
              held = null;
              status = 'blocked';
              error = SITE_BUSY_MESSAGE;
              onLost();
            } else {
              held.expiresAt = record.expires_at;
              renewedAt = now();
              status = 'held';
            }
          }
        }
        const records = await api.listAuditActivity();
        if (stopped) return;
        const changed = JSON.stringify(list) !== JSON.stringify(records) || !loaded || Boolean(error);
        list = records;
        loaded = true;
        if (status !== 'blocked') error = '';
        if (changed) notify();
      } catch (err) {
        if (stopped) return;
        error = err.message;
        // Block editing when the reservation can no longer be verified.
        if (held && Date.parse(held.expiresAt) <= now()) {
          status = 'error';
        }
        notify();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function open(next) {
    if (stopped) return Promise.resolve(false);
    if (same(target, next) && (status === 'checking' || (status === 'held' && held && Date.parse(held.expiresAt) > now()))) return opening || Promise.resolve(true);
    const version = ++generation;
    const previous = held;
    held = null;
    target = next;
    status = 'checking';
    error = '';
    const lease = { ...next, sessionId: makeId() };
    opening = queue = queue.then(async () => {
      await release(previous);
      if (stopped || generation !== version) return false;
      try {
        const record = await api.claimAuditSite(lease);
        if (stopped || generation !== version) {
          if (record) await release(lease);
          return false;
        }
        if (!record) {
          status = 'blocked';
          error = SITE_BUSY_MESSAGE;
          notify();
          return false;
        }
        held = { ...lease, expiresAt: record.expires_at };
        renewedAt = now();
        status = 'held';
        list = [...list.filter((r) => r.home_id !== record.home_id), record];
        notify();
        return true;
      } catch (err) {
        if (generation === version && !stopped) {
          status = 'error';
          error = err.message;
          notify();
        }
        return false;
      }
    });
    notify();
    return opening;
  }

  function close() {
    if (!target && !held) return queue;
    ++generation;
    const previous = held;
    held = null;
    target = null;
    status = 'idle';
    error = '';
    queue = queue.then(() => release(previous));
    notify();
    return queue;
  }

  const timer = schedule(() => {
    if (held && status === 'held' && Date.parse(held.expiresAt) <= now()) {
      status = 'error';
      error = 'Couldn’t verify site availability. Please try again.';
      notify();
    }
    refresh();
  });
  return {
    open, close, refresh,
    watch(enabled) {
      const started = enabled && !watching;
      watching = enabled;
      if (started) refresh();
    },
    snapshot: () => ({ list: activeList(), loaded, status, error, target }),
    owns: (homeId, auditId) => status === 'held' && held?.homeId === homeId && held?.auditId === auditId && Date.parse(held.expiresAt) > now(),
    async stop() {
      stopped = true;
      cancel(timer);
      await close();
    },
  };
}
