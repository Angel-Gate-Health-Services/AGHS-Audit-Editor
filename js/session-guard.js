// Revalidate with the server, not decoded JWT claims or browser-stored profile data.
export function createSessionGuard({ check, onValid, onInvalid, now = Date.now,
  schedule = (fn) => setInterval(fn, 30000), cancel = clearInterval }) {
  let stopped = false;
  let verifiedAt = now(); // The initial profile has already been verified at sign-in.
  let pending = null;
  async function verify(force = false) {
    if (stopped) return false;
    if (pending) return pending;
    if (!force && now() - verifiedAt < 30000) return true;
    pending = (async () => {
      try {
        const profile = await check();
        if (stopped) return false;
        if (!profile?.active) throw new Error('Your account is no longer available. Please sign in again.');
        verifiedAt = now();
        onValid(profile);
        return true;
      } catch {
        if (!stopped) {
          stopped = true;
          cancel(timer);
          onInvalid();
        }
        return false;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }
  const timer = schedule(() => { verify(true); });
  return { verify, stop() { stopped = true; cancel(timer); } };
}
