export const IDLE_BEFORE_WARNING_MS = 120000;
export const LOGOUT_WARNING_MS = 60000;

const TABS_KEY = 'aghs-active-tabs:v1';
const TAB_ID_KEY = 'aghs-tab-id:v1';
const ACTIVITY_KEY = 'aghs-session-activity:v1';
const TAB_STALE_MS = 300000;

const parseJson = (value, fallback) => {
  try { return JSON.parse(value) || fallback; } catch { return fallback; }
};

const randomId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Tracks authenticated site tabs without treating a persisted Supabase token as
// permission to reopen the app after every site tab has been closed.
export function createTabCoordinator({
  sharedStorage = globalThis.localStorage,
  tabStorage = globalThis.sessionStorage,
  now = Date.now,
  makeId = randomId,
  navigationType = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type || 'navigate',
  channelFactory = globalThis.BroadcastChannel ? (name) => new BroadcastChannel(name) : null,
  schedule = (fn) => setInterval(fn, 10000),
  cancel = clearInterval,
} = {}) {
  let tabId = tabStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    tabId = makeId();
    tabStorage.setItem(TAB_ID_KEY, tabId);
  }
  const pageId = makeId();
  let stopped = false;

  const read = () => parseJson(sharedStorage.getItem(TABS_KEY), {});
  const live = (record) => record?.status === 'open' && now() - Number(record.seenAt || 0) < TAB_STALE_MS;
  const write = (records) => sharedStorage.setItem(TABS_KEY, JSON.stringify(records));
  const initial = read();
  const own = initial[tabId];
  const authenticatedOther = Object.entries(initial).some(([id, record]) => id !== tabId && live(record) && record.userId);
  const sameTabReload = navigationType === 'reload' && own?.userId;
  const resumeCandidate = Boolean(authenticatedOther || (live(own) && own.userId) || sameTabReload);
  const resumeUserId = resumeCandidate ? own?.userId || Object.values(initial).find((record) => live(record) && record.userId)?.userId || null : null;
  let userId = null;
  const pendingPings = new Map();
  const channel = channelFactory?.('aghs-session-tabs:v1') || null;

  function update(patch = {}) {
    if (stopped) return;
    const records = read();
    records[tabId] = { pageId, userId, status: 'open', seenAt: now(), ...patch };
    for (const [id, record] of Object.entries(records)) {
      if (id !== tabId && now() - Number(record.seenAt || 0) >= TAB_STALE_MS) delete records[id];
    }
    write(records);
  }

  update();
  let timer = schedule(() => update());
  if (channel) channel.onmessage = ({ data }) => {
    if (data?.type === 'ping' && !stopped && userId) {
      channel.postMessage({ type: 'pong', requestId: data.requestId, userId });
    } else if (data?.type === 'pong' && data.userId) {
      pendingPings.get(data.requestId)?.(data.userId);
    }
  };

  return {
    hasResumeCandidate: () => resumeCandidate,
    async mayResume(waitMs = 500) {
      if (!resumeCandidate) return false;
      // A reload can inherit its own tab record. A genuinely new tab must hear
      // from a live authenticated document, so a crashed/closed stale record
      // cannot reopen the app.
      if (sameTabReload || !channel) return true;
      const requestId = makeId();
      const response = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingPings.delete(requestId);
          resolve(null);
        }, waitMs);
        pendingPings.set(requestId, (nextUserId) => {
          clearTimeout(timeout);
          pendingPings.delete(requestId);
          resolve(nextUserId);
        });
      });
      channel.postMessage({ type: 'ping', requestId });
      const confirmedUserId = await response;
      if (!confirmedUserId || confirmedUserId !== resumeUserId) return false;
      userId = confirmedUserId;
      update({ userId });
      return true;
    },
    setUser(nextUserId) {
      userId = nextUserId || null;
      update({ userId });
    },
    isLastTab() {
      return !Object.entries(read()).some(([id, record]) => id !== tabId && live(record));
    },
    reopen() {
      if (!stopped) return;
      stopped = false;
      update();
      timer = schedule(() => update());
    },
    close() {
      if (stopped) return;
      const records = read();
      if (records[tabId]?.pageId === pageId) {
        records[tabId] = { ...records[tabId], status: 'closed', seenAt: now() };
        write(records);
      }
      stopped = true;
      cancel(timer);
    },
  };
}

export function activityStorage(userId, storage = globalThis.localStorage) {
  const key = `${ACTIVITY_KEY}:${userId}`;
  return {
    read: () => Number(storage.getItem(key)) || 0,
    write: (value) => storage.setItem(key, String(value)),
    key,
  };
}

// Uses a shared last-activity timestamp so activity in any signed-in tab keeps
// the session alive. The warning begins after two minutes and expires a minute later.
export function createIdleSession({
  readActivity,
  writeActivity,
  onWarning,
  onActive,
  onExpire,
  onTick = () => {},
  now = Date.now,
  schedule = (fn) => setInterval(fn, 1000),
  cancel = clearInterval,
  idleMs = IDLE_BEFORE_WARNING_MS,
  warningMs = LOGOUT_WARNING_MS,
}) {
  let stopped = false;
  let warning = false;
  let expired = false;

  function activity() {
    if (stopped || expired) return;
    writeActivity(now());
    onTick(Math.ceil((idleMs + warningMs) / 1000), false);
    if (warning) {
      warning = false;
      onActive();
    }
  }

  function tick() {
    if (stopped || expired) return;
    let last = readActivity();
    if (!last) {
      last = now();
      writeActivity(last);
    }
    const elapsed = Math.max(0, now() - last);
    const secondsLeft = Math.max(0, Math.ceil((idleMs + warningMs - elapsed) / 1000));
    onTick(secondsLeft, elapsed >= idleMs);
    if (elapsed >= idleMs + warningMs) {
      expired = true;
      warning = false;
      onActive();
      onExpire();
      return;
    }
    if (elapsed >= idleMs) {
      warning = true;
      onWarning(Math.max(1, Math.ceil((idleMs + warningMs - elapsed) / 1000)));
    } else if (warning) {
      warning = false;
      onActive();
    }
  }

  activity();
  const timer = schedule(tick);
  return {
    activity,
    check: tick,
    stop() {
      stopped = true;
      cancel(timer);
      if (warning) onActive();
    },
  };
}
