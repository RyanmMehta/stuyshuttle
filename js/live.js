/**
 * Polling with a watchdog, so the live data never quietly stops.
 *
 * Design goals, in order:
 *   1. Never overlap ticks (setTimeout chain, not setInterval) — an overlapping
 *      slow request would otherwise pile up and starve the UI.
 *   2. Never die. A tick that throws or hangs is logged, counted, and the next
 *      one is still scheduled. A hung tick is abandoned after `maxTickMs`.
 *   3. Come back fast. The moment the app is visible again, or the network
 *      returns, we refresh immediately instead of waiting for the next slot.
 *   4. Back off politely when the upstream is failing (up to `maxIntervalMs`),
 *      then snap back to the normal cadence on the first success.
 */
export class Poller {
  constructor({ tick, intervalMs = 8000, maxIntervalMs = 60000, maxTickMs = 15000, onState }) {
    this.tick = tick;
    this.intervalMs = intervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.maxTickMs = maxTickMs;
    this.onState = onState || (() => {});
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.lastSuccessAt = null;
    this.lastAttemptAt = null;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this._bound = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (!this._bound) {
      this._bound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.running) this.refreshNow();
      });
      window.addEventListener('online', () => this.running && this.refreshNow());
      window.addEventListener('pageshow', () => this.running && this.refreshNow());
      window.addEventListener('focus', () => this.running && this.refreshNow());
    }
    this.refreshNow();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run a tick as soon as possible (coalesces if one is already in flight). */
  refreshNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) { this._pendingRefresh = true; return; }
    this._run();
  }

  async _run() {
    if (!this.running) return;
    // Skip polling while hidden — but never skip the very first fetch, so the
    // app has real data the moment it's looked at even if it was opened in
    // the background (or a test harness keeps the tab hidden).
    if (document.hidden && this.lastSuccessAt !== null) { this._schedule(this.intervalMs); return; }

    this.inFlight = true;
    this.lastAttemptAt = Date.now();
    this.onState(this.state());

    let ok = false;
    try {
      await Promise.race([
        this.tick(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tick timed out')), this.maxTickMs)),
      ]);
      ok = true;
    } catch (err) {
      this.lastError = err?.message || String(err);
    }

    if (ok) {
      this.lastSuccessAt = Date.now();
      this.consecutiveFailures = 0;
      this.lastError = null;
    } else {
      this.consecutiveFailures++;
    }
    this.inFlight = false;
    this.onState(this.state());

    if (this._pendingRefresh) {
      this._pendingRefresh = false;
      this._run();
      return;
    }
    // Exponential backoff on failure, capped; normal cadence on success.
    const delay = ok
      ? this.intervalMs
      : Math.min(this.maxIntervalMs, this.intervalMs * 2 ** Math.min(this.consecutiveFailures, 4));
    this._schedule(delay);
  }

  _schedule(ms) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._run(), ms);
  }

  /** Freshness summary the UI can render without knowing the internals. */
  state(now = Date.now()) {
    const age = this.lastSuccessAt ? now - this.lastSuccessAt : null;
    let level = 'fresh';
    if (age === null) level = this.consecutiveFailures ? 'dead' : 'starting';
    else if (age > 150_000) level = 'dead';
    else if (age > 45_000) level = 'stale';
    return {
      level,
      ageMs: age,
      inFlight: this.inFlight,
      failures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
}

/**
 * Last line of defence: if anything throws outside a tick — a render bug, a
 * malformed response we didn't anticipate — we get told, so the app can fall
 * back to a safe view instead of a frozen or blank screen.
 */
export function installGlobalGuards(onCrash) {
  let reported = 0;
  const report = (err, source) => {
    // Rate-limit so a render bug can't loop into a crash storm.
    if (reported++ > 5) return;
    try { onCrash(err, source); } catch { /* the guard must never throw */ }
  };
  window.addEventListener('error', (e) => report(e.error || e.message, 'error'));
  window.addEventListener('unhandledrejection', (e) => report(e.reason, 'promise'));
}

/** "just now", "8s ago", "3m ago" — for the freshness pill. */
export function fmtAge(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
