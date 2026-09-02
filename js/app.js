/**
 * StuyShuttle — controller.
 *
 * Boot order is deliberate: render *instantly* from whatever we already have
 * (cached last-good data, else the baked timetable), then start live polling
 * at Passio's own cadence, then quietly re-check the timetable against NYU in
 * the background. At no point is the screen blank or spinning.
 */
import * as api from './api.js';
import { Poller, installGlobalGuards, fmtAge } from './live.js';
import { h, el, icon, toast, fmtTime } from './ui.js';
import {
  ROUTES, HOME_STOPS, MIN, buildDepartures, planTrip, heroFor, rideMinutesBetween, servesOn,
} from './schedule.js';
import {
  loadPrefs, savePrefs, cacheResponse, readCache, loadTimetableOverlay, saveTimetableOverlay,
} from './store.js';
import {
  refreshRouteTimetable, probeServiceDays, mergeServiceDays, nextServiceDate, dayProbe,
} from './timetable.js';
import { buildIcs, buildLeaveEvents } from './ics.js';
import * as push from './push.js';
import { renderTrip } from './views/trip.js';
import { renderAlerts } from './views/alerts.js';
import { renderRoutes } from './views/routes.js';
import { renderSettings } from './views/settings.js';

const $ = (sel) => document.querySelector(sel);

/** Testing hook: ?now=2026-09-02T07:45 pins the clock (New York wall time). */
const TIME_OVERRIDE = (() => {
  const raw = new URLSearchParams(location.search).get('now');
  if (!raw) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + nyOffsetForIso(raw));
  return Number.isNaN(t) ? null : t - Date.now();
})();
function nyOffsetForIso(raw) {
  const guess = Date.parse(raw + 'Z');
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = /GMT([+-]\d{1,2})/.exec(tz);
  const n = m ? +m[1] : -5;
  return `${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}:00`;
}
const nowMs = () => Date.now() + (TIME_OVERRIDE ?? 0);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  prefs: loadPrefs(),
  tab: 'trip',
  routeTab: 'C',
  direction: 'toCampus',
  baked: null,
  overlay: loadTimetableOverlay(),
  walk: null,
  seed: null,
  eta: null,
  alerts: readCache('alerts') || [],
  vehicles: [],
  offline: !navigator.onLine,
  freshness: null,
  pushState: { status: 'off', busy: false, error: null },
  timetableStatus: { refreshing: false, lastRefreshAt: null, warnings: [] },
  booted: false,
  safeMode: false,
};

/** Baked snapshot with the live-refreshed overlay layered on top. */
function snapshot() {
  const b = state.baked || { schedules: {}, serviceDays: {}, sequences: {}, stops: {}, routes: [] };
  const o = state.overlay || {};
  return {
    ...b,
    schedules: { ...(b.schedules || {}), ...(o.schedules || {}) },
    serviceDays: { ...(b.serviceDays || {}), ...(o.serviceDays || {}) },
  };
}

function activeContext() {
  const snap = snapshot();
  if (state.direction === 'toCampus') {
    const stop = HOME_STOPS.find((s) => s.id === state.prefs.homeStopId) || HOME_STOPS[0];
    const route = ROUTES[stop.route];
    const seq = snap.sequences?.[route.id] || [];
    const position = seq.find((x) => x.stopId === stop.id)?.position || '1';
    return { stop, route, position, dropoff: route.dropoff };
  }
  // Heading home: board Route E at 715 Broadway, get off at First Ave/17th.
  const route = ROUTES.E;
  const seq = snap.sequences?.[route.id] || [];
  return {
    stop: { id: '6545', name: '715 Broadway', route: 'E' },
    route,
    position: seq.find((x) => x.stopId === '6545')?.position || '1',
    dropoff: '6566',
  };
}

function destinationName(dropoffStopId) {
  if (state.direction === 'toCampus') {
    return state.walk?.buildings?.[state.prefs.building]?.name || 'campus';
  }
  return HOME_STOPS.find((s) => s.id === dropoffStopId)?.name || 'Stuytown';
}

/** Everything the views need, computed once per render. */
function derive(now) {
  const snap = snapshot();
  const { stop, route, position, dropoff } = activeContext();
  const schedule = snap.schedules?.[route.id] || null;
  const fallbackTimes = schedule?.stops?.find((s) => s.stopId === stop.id)?.times || [];
  const servesToday = servesOn(snap.serviceDays, route.id, now);
  const eta = state.safeMode ? null : state.eta;

  const result = buildDepartures({ eta, fallbackTimes, offline: state.offline, servesToday, now });
  const ride = rideMinutesBetween(schedule, stop.id, dropoff, snap.sequences?.[route.id]);

  const toCampus = state.direction === 'toCampus';
  const walkToStop = toCampus
    ? state.prefs.walkToStop
    : state.walk?.stopToBuilding?.['6545']?.[state.prefs.building] ?? 7;
  const walkToBuilding = toCampus
    ? state.walk?.stopToBuilding?.[dropoff]?.[state.prefs.building] ?? 7
    : state.walk?.homeToStop?.[dropoff] ?? 4;

  const trips = result.departures.slice(0, 6).map((d) =>
    planTrip({
      departsAt: d.at, walkToStop, buffer: state.prefs.buffer,
      rideMinutes: ride.minutes ?? 15, walkToBuilding, arrivalEstimated: ride.estimated,
      now, vehicle: d.vehicle, live: d.live, stopsAway: d.stopsAway, late: d.late,
    }));
  const hero = heroFor(trips, now);

  return {
    stop, route, position, dropoff, schedule, result, ride, trips, hero,
    walkToStop, walkToBuilding, destName: destinationName(dropoff),
  };
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

const fast = new Poller({
  intervalMs: 7000,               // Passio's own client polls every 7s
  maxTickMs: 12000,
  onState: (s) => { state.freshness = s; renderTopbar(); },
  tick: async () => {
    const { stop, route, position } = activeContext();
    const [eta, vehicles] = await Promise.all([
      api.getEta(stop.id, route.id, position, TIME_OVERRIDE ? new Date(nowMs()) : null),
      api.getVehicles().catch(() => state.vehicles),
    ]);
    state.eta = eta;
    state.vehicles = vehicles;
    state.offline = false;
    cacheResponse('eta:' + stop.id, eta);
    if (state.tab === 'trip') render();
  },
});

const slow = new Poller({
  intervalMs: 30000,
  maxTickMs: 12000,
  tick: async () => {
    const alerts = await api.getAlerts();
    const before = new Set(state.prefs.seenAlertIds || []);
    const fresh = alerts.filter((a) => !before.has(a.id));
    state.alerts = alerts;
    cacheResponse('alerts', alerts);
    if (state.booted && fresh.length) {
      const relevant = fresh.filter((a) => a.relevant !== false);
      if (relevant.length) toast(`New NYU alert: ${relevant[0].title}`, 'warn', 5000);
    }
    state.prefs = savePrefs({ seenAlertIds: [...new Set([...alerts.map((a) => a.id), ...before])].slice(0, 300) });
    updateBadge();
    if (state.tab === 'trip' || state.tab === 'alerts') render();
  },
});

window.addEventListener('offline', () => { state.offline = true; render(); });
window.addEventListener('online', () => { state.offline = false; fast.refreshNow(); slow.refreshNow(); });

function updateBadge() {
  const n = state.alerts.filter((a) => a.relevant !== false && !state.prefs.dismissedAlerts.includes(a.id)).length;
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch { /* unsupported */ }
}

// ---------------------------------------------------------------------------
// Timetable self-refresh (the app re-checks NYU's schedule; no re-bake needed)
// ---------------------------------------------------------------------------

function nyDateKey(ts = nowMs()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));
}

async function refreshTimetable({ force = false } = {}) {
  if (state.timetableStatus.refreshing || !state.baked) return;
  const today = nyDateKey();
  const overlay = state.overlay || { schedules: {}, serviceDays: {}, refreshedAt: {} };
  const due = Object.values(ROUTES).filter((r) => force || overlay.refreshedAt?.[r.id] !== today);
  if (!due.length) return;

  state.timetableStatus = { ...state.timetableStatus, refreshing: true };
  if (state.tab !== 'trip') render();

  const snap = snapshot();
  const warnings = [];
  for (const r of due) {
    try {
      const serviceDays = snap.serviceDays?.[r.id];
      const probeDay = nextServiceDate(serviceDays, new Date(nowMs()));
      const { schedule, warnings: w, changed } = await refreshRouteTimetable({
        routeId: r.id,
        sequence: snap.sequences?.[r.id],
        stopNames: Object.fromEntries(Object.values(snap.stops || {}).map((s) => [s.id, s.name])),
        routeMeta: { name: r.name, color: r.color },
        prev: snap.schedules?.[r.id] || null,
        seed: state.seed,
        when: dayProbe(probeDay),
        delayMs: 150,
      });
      if (schedule) {
        overlay.schedules[r.id] = schedule;
        overlay.refreshedAt[r.id] = today;
        if (changed && state.booted) toast(`${r.name} timetable updated from NYU`, 'info');
      }
      warnings.push(...w.map((x) => `${r.name}: ${x}`));

      // Service days: re-probe weekly (7 calls per route).
      const weekKey = `days:${r.id}`;
      const lastProbe = overlay.refreshedAt?.[weekKey];
      if (force || !lastProbe || Date.now() - Date.parse(lastProbe) > 7 * 86_400_000) {
        const timed = schedule?.stops?.find((s) => s.times.length);
        if (timed) {
          const fresh = await probeServiceDays(r.id, timed.stopId, timed.position, { from: new Date(nowMs()), delayMs: 150 });
          overlay.serviceDays[r.id] = mergeServiceDays(snap.serviceDays?.[r.id], fresh);
          overlay.refreshedAt[weekKey] = new Date().toISOString();
        }
      }
    } catch (err) {
      warnings.push(`${r.name}: could not check (${err?.message || err})`);
    }
  }
  state.overlay = overlay;
  saveTimetableOverlay(overlay);
  state.timetableStatus = { refreshing: false, lastRefreshAt: Date.now(), warnings };
  render();
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function computePushState() {
  let status = 'off';
  if (!push.pushConfigured()) status = 'unconfigured';
  else if (!push.pushSupported()) status = 'unsupported';
  else if (push.isIosNeedingInstall()) status = 'needs-install';
  else status = (await push.currentSubscription().catch(() => null)) ? 'on' : 'off';
  state.pushState = { ...state.pushState, status };
}

function pushPrefs() {
  const { stop, route, position } = activeContext();
  return {
    routeId: route.id, stopId: stop.id, position,
    walkToStop: state.prefs.walkToStop, buffer: state.prefs.buffer,
    notifyOtherServices: state.prefs.notifyOtherServices,
  };
}

// ---------------------------------------------------------------------------
// Actions (what the views can do)
// ---------------------------------------------------------------------------

const actions = {
  setTab(tab) {
    state.tab = tab;
    state.prefs = savePrefs({ tab });
    if (tab === 'alerts') {
      // Reading the feed clears the badge.
      const ids = state.alerts.map((a) => a.id);
      state.prefs = savePrefs({ dismissedAlerts: [...new Set([...state.prefs.dismissedAlerts, ...ids])].slice(0, 300) });
      updateBadge();
    }
    window.scrollTo(0, 0);
    render();
  },
  setDirection(dir) {
    if (state.direction === dir) return;
    state.direction = dir;
    // A cached ETA's scheduleTimes are "future as of when it was fetched";
    // that's fine within 2 minutes of real time, but meaningless when the
    // clock is pinned for testing, so bypass it then.
    state.eta = TIME_OVERRIDE ? null : readCache('eta:' + activeContext().stop.id, 2 * MIN) || null;
    render();
    fast.refreshNow();
  },
  setRouteTab(key) { state.routeTab = key; render(); },
  refresh() { fast.refreshNow(); slow.refreshNow(); },
  savePrefs(patch) {
    const stopChanged = patch.homeStopId && patch.homeStopId !== state.prefs.homeStopId;
    state.prefs = savePrefs(patch);
    render();
    if (stopChanged) { state.eta = null; fast.refreshNow(); }
    // Keep the push service's copy of your prefs current.
    if (state.pushState.status === 'on' && (stopChanged || 'walkToStop' in patch || 'buffer' in patch || 'notifyOtherServices' in patch)) {
      push.subscribe(pushPrefs()).catch(() => {});
    }
  },
  dismissAlert(id) {
    state.prefs = savePrefs({ dismissedAlerts: [...state.prefs.dismissedAlerts, id] });
    updateBadge();
    render();
  },
  refreshTimetable() { refreshTimetable({ force: true }); },
  async subscribePush() {
    state.pushState = { ...state.pushState, busy: true, error: null };
    render();
    try {
      await push.subscribe(pushPrefs());
      state.pushState = { status: 'on', busy: false, error: null };
      toast('Notifications on', 'ok');
    } catch (err) {
      state.pushState = { ...state.pushState, busy: false, error: err?.message || 'Could not enable' };
    }
    render();
  },
  async unsubscribePush() {
    state.pushState = { ...state.pushState, busy: true };
    render();
    try { await push.unsubscribe(); } catch { /* ignore */ }
    state.pushState = { status: 'off', busy: false, error: null };
    render();
  },
  downloadCalendar() {
    const d = derive(nowMs());
    const chosen = state.prefs.usualDeparture;
    const events = buildLeaveEvents({
      snapshot: snapshot(), routeId: d.route.id, stopId: d.stop.id,
      walkToStop: d.walkToStop, buffer: state.prefs.buffer,
      rideMinutes: d.ride.minutes ?? 15, walkToBuilding: d.walkToBuilding,
      destinationName: d.destName, onlyDepartures: [chosen], weeks: 16, from: new Date(nowMs()),
    });
    if (!events.length) { toast('Nothing to schedule for that departure', 'warn'); return; }
    const ics = buildIcs({ events, alarmMinutesBefore: 0, calendarName: `StuyShuttle — ${chosen} shuttle` });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url; a.download = `stuyshuttle-${chosen.replace(/[:\s]/g, '')}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${events.length} alarms ready — open the file and Add All`, 'ok', 4500);
  },
  resetApp() {
    if (!confirm('Reset StuyShuttle settings and cached data on this device?')) return;
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('stuyshuttle.')) localStorage.removeItem(k);
    } catch { /* ignore */ }
    location.reload();
  },
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function ctx() {
  const now = nowMs();
  return {
    now, prefs: state.prefs, snapshot: snapshot(), walk: state.walk,
    direction: state.direction, eta: state.safeMode ? null : state.eta,
    alerts: state.alerts, vehicles: state.vehicles, offline: state.offline,
    freshness: state.freshness, pushState: state.pushState,
    timetableStatus: state.timetableStatus, ui: { routeTab: state.routeTab },
    actions, derived: derive(now),
  };
}

function render() {
  const root = $('#app');
  if (!root) return;
  const scrollY = window.scrollY;
  try {
    const c = ctx();
    const view =
      state.tab === 'alerts' ? renderAlerts(c)
      : state.tab === 'routes' ? renderRoutes(c)
      : state.tab === 'settings' ? renderSettings(c)
      : renderTrip(c);
    root.replaceChildren(view, renderFooter());
    renderTopbar();
    renderTabbar();
    window.scrollTo(0, scrollY);
  } catch (err) {
    renderSafe(err);
  }
}

function renderTopbar() {
  const bar = $('#status');
  if (!bar) return;
  const f = state.freshness;
  let level = 'starting', text = 'Connecting…';
  if (state.offline) { level = 'offline'; text = 'Offline'; }
  else if (f) {
    if (f.level === 'fresh') { level = 'fresh'; text = `Live · ${fmtAge(f.ageMs)}`; }
    else if (f.level === 'stale') { level = 'stale'; text = 'Reconnecting…'; }
    else if (f.level === 'dead') { level = 'dead'; text = 'No live data'; }
    else { level = 'starting'; text = f.inFlight ? 'Updating…' : 'Connecting…'; }
  }
  bar.className = `status status--${level}`;
  bar.replaceChildren(h('span', { class: 'status__dot' }), h('span', null, text));
  bar.onclick = actions.refresh;
}

function renderTabbar() {
  const nav = $('#tabbar');
  if (!nav) return;
  const unread = state.alerts.filter((a) => a.relevant !== false && !state.prefs.dismissedAlerts.includes(a.id)).length;
  const tab = (key, label, ic, count) =>
    h('button', { class: `tab ${state.tab === key ? 'is-active' : ''}`, onclick: () => actions.setTab(key), 'aria-current': state.tab === key ? 'page' : null },
      h('span', { class: 'tab__icon' }, icon(ic, 22), count ? h('span', { class: 'tab__count' }, count) : null),
      h('span', { class: 'tab__label' }, label));
  nav.replaceChildren(
    tab('trip', 'Trip', 'bus'),
    tab('alerts', 'Alerts', 'bell', unread),
    tab('routes', 'Routes', 'route'),
    tab('settings', 'Settings', 'settings'));
}

function renderFooter() {
  const bits = [];
  if (state.freshness?.lastSuccessAt) bits.push(`Updated ${fmtTime(state.freshness.lastSuccessAt)}`);
  if (TIME_OVERRIDE) bits.push('CLOCK PINNED');
  if (state.safeMode) bits.push('SAFE MODE');
  return h('footer', { class: 'footer' }, bits.join(' · '));
}

/** Absolute fallback: plain DOM, baked data only, cannot depend on anything that just failed. */
function renderSafe(err) {
  console.error('render failed; entering safe mode', err);
  state.safeMode = true;
  const root = $('#app');
  const snap = snapshot();
  const { stop, route } = activeContext();
  const times = snap.schedules?.[route.id]?.stops?.find((s) => s.stopId === stop.id)?.times || [];
  root.replaceChildren(
    el('section', 'hero hero--empty'),
  );
  const box = root.firstChild;
  box.append(el('div', 'hero__kicker', 'Timetable (safe mode)'));
  box.append(el('div', 'hero__empty-title', `${route.name} from ${stop.name}`));
  box.append(el('div', 'hero__arrive', times.length ? times.join('  ·  ') : 'No published times'));
  box.append(el('div', 'muted small', 'Something went wrong rendering live data. This is the published timetable. Pull to refresh or reopen the app.'));
  const btn = el('button', 'btn btn--secondary', 'Try again');
  btn.onclick = () => { state.safeMode = false; render(); };
  box.append(btn);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  installGlobalGuards((err) => { toast('Recovered from an error', 'warn'); if (!state.safeMode) renderSafe(err); });

  // Deep link from a notification: index.html#alerts
  const applyHash = () => {
    const t = location.hash.replace('#', '');
    if (['trip', 'alerts', 'routes', 'settings'].includes(t)) { state.tab = t; render(); }
  };
  window.addEventListener('hashchange', applyHash);

  try {
    const [baked, walk, seed] = await Promise.all([
      api.getSnapshot(),
      api.getWalkTimes(),
      fetch('./data/seed-times.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    state.baked = baked; state.walk = walk; state.seed = seed;
  } catch {
    $('#app').replaceChildren(el('div', 'booting', 'Could not load timetable data. Check your connection and reopen.'));
    return;
  }

  state.tab = 'trip'; // always open on the answer; deep links (#alerts) still work
  state.eta = TIME_OVERRIDE ? null : readCache('eta:' + activeContext().stop.id, 2 * MIN) || null;
  applyHash();
  render();                       // instant: cached/baked
  await computePushState();
  render();

  fast.start();
  slow.start();
  state.booted = true;

  // Countdown tick; cheap because rounding is to the minute.
  setInterval(() => { if (!document.hidden && state.tab === 'trip') render(); }, 10_000);

  // Background: re-check the timetable against NYU once per day.
  setTimeout(() => refreshTimetable().catch(() => {}), 2500);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// Debug/test handle: `__stuy.fast.refreshNow()`, `__stuy.state`, `__stuy.render()`.
window.__stuy = { state, fast, slow, render, refreshTimetable, actions };

boot();
