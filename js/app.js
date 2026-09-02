/**
 * StuyShuttle — controller.
 *
 * Boot: render instantly from the baked data, then start live polling at
 * Passio's own cadence, then refresh route ids / stop sequences in the
 * background once a day (Passio re-creates routes under new ids between
 * semesters). The screen is never blank and never spinning.
 */
import * as api from './api.js';
import { Poller, installGlobalGuards, fmtAge } from './live.js';
import { h, el, icon, toast, fmtTime } from './ui.js';
import { MIN, explainNoService, minutesUntil } from './schedule.js';
import { loadPrefs, savePrefs, cacheResponse, readCache, loadTimetableOverlay, saveTimetableOverlay } from './store.js';
import { ROUTES, resolveRouteIds, dayTypeFor, tableFor, stopTimes, stopName, CAMPUS_STOP } from './routes.js';
import { planOptions, chooseHero, upcomingRows, applyLiveValidated } from './planner.js';
import { classifyArrivals } from './geo.js';
import { buildIcs, buildLeaveEvents } from './ics.js';
import * as push from './push.js';
import { renderTrip } from './views/trip.js';
import { renderAlerts } from './views/alerts.js';
import { renderTimetable } from './views/timetable.js';
import { renderMap, teardownMap } from './views/map.js';
import { renderSettings } from './views/settings.js';

const $ = (sel) => document.querySelector(sel);
const TABS = ['trip', 'map', 'alerts', 'timetable', 'settings'];

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
  direction: 'toCampus',
  ui: { dayType: null },
  baked: null,       // Passio snapshot: stops, sequences, routes, routeIds
  official: null,    // NYU's published timetables (data/official.json)
  overlay: loadTimetableOverlay(),
  walk: null,
  eta: null, etaFor: null,
  alerts: readCache('alerts') || [],
  vehicles: [],
  offline: !navigator.onLine,
  freshness: null,
  pushState: { status: 'off', busy: false, error: null },
  timetableStatus: { refreshing: false, lastRefreshAt: null, warnings: [] },
  booted: false, safeMode: false,
};

/** Baked snapshot with daily-refreshed route ids / sequences layered on top. */
function snapshot() {
  const b = state.baked || { sequences: {}, stops: {}, routes: [], routeIds: {} };
  const o = state.overlay || {};
  return {
    ...b,
    routeIds: { ...(b.routeIds || {}), ...(o.routeIds || {}) },
    sequences: { ...(b.sequences || {}), ...(o.sequences || {}) },
    stops: { ...(b.stops || {}), ...(o.stops || {}) },
    routePoints: { ...(b.routePoints || {}), ...(o.routePoints || {}) },
  };
}
const routeIdOf = (key) => snapshot().routeIds?.[key] || null;
function positionOf(key, stopId) {
  const seq = snapshot().sequences?.[routeIdOf(key)] || [];
  return seq.find((x) => x.stopId === stopId)?.position || null;
}
/** Walk times with your personal overrides applied. */
function effectiveWalk() {
  const w = state.walk || {};
  return { ...w, homeToStop: { ...(w.homeToStop || {}), ...(state.prefs.walkOverrides || {}) } };
}
function destinationName(alightId) {
  if (state.direction === 'toCampus') return state.walk?.buildings?.[state.prefs.building]?.name || 'campus';
  return stopName(alightId);
}

/** Everything the views need, computed once per render. */
function derive(now) {
  const walk = effectiveWalk();
  const options = state.safeMode ? [] : planOptions({ direction: state.direction, official: state.official, walk, prefs: state.prefs, now });
  let rows = upcomingRows(options, 6, state.prefs.homeStopId);
  let hero = chooseHero(options, now, state.prefs.homeStopId);

  // GPS-validated live overlay for the bus we are polling (the hero's stop).
  const live = state.safeMode ? null : state.eta;
  const snap = snapshot();
  if (live && hero.trip && state.etaFor === `${hero.trip.route}:${hero.trip.stopId}`) {
    const routeId = routeIdOf(hero.trip.route);
    const geoCtx = { vehicles: state.vehicles, sequence: snap.sequences?.[routeId] || [], stops: snap.stops || {}, targetStopId: hero.trip.stopId, routeName: ROUTES[hero.trip.route]?.name };
    const table = tableFor(state.official, hero.trip.route, now);
    const schedTimes = table ? stopTimes(table, hero.trip.stopId, 'board', now) : [];
    const t = applyLiveValidated(hero.trip, live, geoCtx, schedTimes, now);
    hero = t.missed ? { mode: 'missed', trip: t } : t.tight ? { mode: 'now', trip: t } : { mode: 'wait', trip: t, leaveIn: minutesUntil(t.leaveAt, now) };
    // Reflect the same live bus on its matching row.
    rows = rows.map((r) => (r.route === hero.trip.route && r.stopId === hero.trip.stopId ? { ...r, ...t, alternatives: r.alternatives } : r));
  }
  // NYU's live system says the hero's route is out of service today → don't show its timetable as if running.
  const outOfService = Boolean(live?.outOfService && hero.trip && state.etaFor?.startsWith(hero.trip.route + ':'));
  if (outOfService) { hero = { mode: 'none', trip: null, outOfService: true }; rows = rows.filter((r) => r.route !== state.etaFor.split(':')[0]); }

  const heroRoute = hero.trip ? ROUTES[hero.trip.route] : null;
  const emptyWhy = (!hero.trip || hero.mode === 'none') ? emptyExplanation(now, outOfService) : null;

  return {
    options, rows, hero, heroRoute, emptyWhy,
    destName: destinationName(hero.trip?.alightId || (state.direction === 'toCampus' ? CAMPUS_STOP : state.prefs.homeAlightStopId || '6566')),
    pollTarget: hero.trip ? { route: hero.trip.route, stopId: hero.trip.stopId } : null,
    walkToStop: hero.trip?.walkToStop ?? state.prefs.walkToStop,
  };
}

function emptyExplanation(now, outOfService) {
  const keys = (state.direction === 'toCampus' ? ['C', 'E', 'W'] : ['E', 'W']).filter((k) => dayTypeFor(k, now));
  const key = keys[0] || (state.direction === 'toCampus' ? 'C' : 'E');
  const stopId = state.direction === 'toCampus' ? (key === 'C' ? state.prefs.homeStopId : '6566') : CAMPUS_STOP;
  const table = tableFor(state.official, key, now);
  const serviceDays = Object.fromEntries(Object.values(ROUTES).map((r) => [r.key, [0, 1, 2, 3, 4, 5, 6].map((d) => Boolean(r.days[d]))]));
  return explainNoService(new Date(now), state.direction, {
    serviceDays, routeId: key, outOfService,
    todaysTimes: table ? stopTimes(table, stopId, 'board', now) : [],
    routeName: ROUTES[key].name, stopName: stopName(stopId),
  });
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

let lastPollTarget = null;

const fast = new Poller({
  intervalMs: 7000, maxTickMs: 12000,
  onState: (s) => { state.freshness = s; renderTopbar(); },
  tick: async () => {
    const target = derive(nowMs()).pollTarget;
    lastPollTarget = target;
    const routeId = target ? routeIdOf(target.route) : null;
    const position = target ? positionOf(target.route, target.stopId) : null;
    const [eta, vehicles] = await Promise.all([
      target && routeId && position ? api.getEta(target.stopId, routeId, position, TIME_OVERRIDE ? new Date(nowMs()) : null) : Promise.resolve(null),
      api.getVehicles().catch(() => state.vehicles),
    ]);
    state.eta = eta;
    state.etaFor = target ? `${target.route}:${target.stopId}` : null;
    state.vehicles = vehicles;
    state.offline = false;
    if (state.tab === 'trip') render();
  },
});

const slow = new Poller({
  intervalMs: 30000, maxTickMs: 12000,
  tick: async () => {
    const alerts = await api.getAlerts();
    const before = new Set(state.prefs.seenAlertIds || []);
    const fresh = alerts.filter((a) => !before.has(a.id));
    state.alerts = alerts;
    cacheResponse('alerts', alerts);
    if (state.booted && fresh.some((a) => a.relevant !== false)) {
      toast(`New NYU alert: ${fresh.find((a) => a.relevant !== false).title}`, 'warn', 5000);
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
// Daily: route ids + stop sequences (ids change between semesters)
// ---------------------------------------------------------------------------

const nyDateKey = (ts = nowMs()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));

async function refreshDirectory({ force = false } = {}) {
  if (state.timetableStatus.refreshing) return;
  const today = nyDateKey();
  const overlay = state.overlay || {};
  if (!force && overlay.directoryDay === today) return;
  state.timetableStatus = { ...state.timetableStatus, refreshing: true };
  const warnings = [];
  try {
    const [routes, seq] = await Promise.all([api.getRoutes(), api.getStopSequences()]);
    const ids = resolveRouteIds(routes);
    const prev = snapshot().routeIds;
    for (const [k, id] of Object.entries(ids)) if (prev[k] && prev[k] !== id) warnings.push(`${ROUTES[k].name} moved to a new id (${prev[k]} → ${id})`);
    overlay.routeIds = ids; overlay.sequences = seq.sequences; overlay.stops = seq.stops; overlay.routePoints = seq.routePoints;
    overlay.directoryDay = today;
    state.overlay = overlay; saveTimetableOverlay(overlay);
    if (warnings.length && state.booted) toast(warnings[0], 'warn', 5000);
  } catch (err) {
    warnings.push(`Could not refresh route directory (${err?.message || err})`);
  }
  state.timetableStatus = { refreshing: false, lastRefreshAt: Date.now(), warnings };
  if (state.tab !== 'trip') render();
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
  const d = derive(nowMs());
  const routeKey = d.pollTarget?.route || 'C';
  const stopId = d.pollTarget?.stopId || state.prefs.homeStopId;
  return {
    routeKey, stopId, position: positionOf(routeKey, stopId) || '1',
    walkToStop: d.walkToStop, buffer: state.prefs.buffer, notifyOtherServices: state.prefs.notifyOtherServices,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const actions = {
  setTab(tab) {
    state.tab = tab;
    if (tab === 'alerts') {
      const ids = state.alerts.map((a) => a.id);
      state.prefs = savePrefs({ dismissedAlerts: [...new Set([...state.prefs.dismissedAlerts, ...ids])].slice(0, 300) });
      updateBadge();
    }
    window.scrollTo(0, 0);
    render();
  },
  setDirection(dir) {
    if (state.direction === dir) return;
    state.direction = dir; state.eta = null; state.etaFor = null;
    render(); fast.refreshNow();
  },
  setDayType(dt) { state.ui.dayType = dt; render(); },
  refresh() { fast.refreshNow(); slow.refreshNow(); },
  savePrefs(patch) {
    state.prefs = savePrefs(patch);
    state.eta = null; state.etaFor = null;
    render(); fast.refreshNow();
    if (state.pushState.status === 'on') push.subscribe(pushPrefs()).catch(() => {});
  },
  dismissAlert(id) {
    state.prefs = savePrefs({ dismissedAlerts: [...state.prefs.dismissedAlerts, id] });
    updateBadge(); render();
  },
  refreshTimetable() { refreshDirectory({ force: true }); },
  async subscribePush() {
    state.pushState = { ...state.pushState, busy: true, error: null }; render();
    try { await push.subscribe(pushPrefs()); state.pushState = { status: 'on', busy: false, error: null }; toast('Notifications on', 'ok'); }
    catch (err) { state.pushState = { ...state.pushState, busy: false, error: err?.message || 'Could not enable' }; }
    render();
  },
  async unsubscribePush() {
    state.pushState = { ...state.pushState, busy: true }; render();
    try { await push.unsubscribe(); } catch { /* ignore */ }
    state.pushState = { status: 'off', busy: false, error: null }; render();
  },
  downloadCalendar() {
    const now = nowMs();
    const d = derive(now);
    const t = d.hero.trip || d.rows[0];
    if (!t) { toast('Nothing to schedule right now', 'warn'); return; }
    const key = t.route;
    // Official times at the boarding stop, as a Passio-shaped schedule for the ICS builder.
    const dayTypes = [...new Set(Object.values(ROUTES[key].days))];
    const table = state.official?.routes?.[key]?.[dayTypes[0]];
    const times = table ? stopTimes(table, t.stopId, 'board', now) : [];
    const chosen = state.prefs.usualDeparture && times.includes(state.prefs.usualDeparture) ? state.prefs.usualDeparture : fmtTime(t.departsAt);
    const events = buildLeaveEvents({
      snapshot: { schedules: { [key]: { name: ROUTES[key].name, stops: [{ stopId: t.stopId, name: t.stopLabel, times }] } },
        serviceDays: { [key]: [0, 1, 2, 3, 4, 5, 6].map((dd) => Boolean(ROUTES[key].days[dd])) } },
      routeId: key, stopId: t.stopId, walkToStop: t.walkToStop, buffer: state.prefs.buffer,
      rideMinutes: t.rideMin, walkToBuilding: t.walkToBuilding, destinationName: d.destName,
      onlyDepartures: [chosen], weeks: 16, from: new Date(now),
    });
    if (!events.length) { toast('Nothing to schedule for that departure', 'warn'); return; }
    const ics = buildIcs({ events, alarmMinutesBefore: 0, calendarName: `StuyShuttle — ${chosen} ${ROUTES[key].name}` });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a'); a.href = url; a.download = `stuyshuttle-${key}-${chosen.replace(/[:\s]/g, '')}.ics`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${events.length} alarms ready — open the file and Add All`, 'ok', 4500);
  },
  resetApp() {
    if (!confirm('Reset StuyShuttle settings and cached data on this device?')) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('stuyshuttle.')) localStorage.removeItem(k); } catch { /* ignore */ }
    location.reload();
  },
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function ctx() {
  const now = nowMs();
  return {
    now, prefs: state.prefs, snapshot: snapshot(), official: state.official, walk: effectiveWalk(),
    direction: state.direction, eta: state.safeMode ? null : state.eta, etaFor: state.etaFor,
    alerts: state.alerts, vehicles: state.vehicles, offline: state.offline,
    freshness: state.freshness, pushState: state.pushState, timetableStatus: state.timetableStatus,
    ui: state.ui, actions, derived: derive(now), routeIdOf, stateTab: () => state.tab,
  };
}

function render() {
  const root = $('#app');
  if (!root) return;
  const scrollY = window.scrollY;
  try {
    const c = ctx();
    if (state.tab !== 'map') teardownMap();
    const view = state.tab === 'map' ? renderMap(c)
      : state.tab === 'alerts' ? renderAlerts(c)
      : state.tab === 'timetable' ? renderTimetable(c)
      : state.tab === 'settings' ? renderSettings(c)
      : renderTrip(c);
    root.replaceChildren(view, renderFooter());
    renderTopbar(); renderTabbar();
    window.scrollTo(0, scrollY);
    // Poll the hero's stop when it changes (e.g. direction toggled, bus passed).
    const target = c.derived.pollTarget;
    const key = target ? `${target.route}:${target.stopId}` : null;
    if (key && key !== state.etaFor && (!lastPollTarget || `${lastPollTarget.route}:${lastPollTarget.stopId}` !== key)) fast.refreshNow();
  } catch (err) {
    renderSafe(err);
  }
}

function renderTopbar() {
  const bar = $('#status'); if (!bar) return;
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
  const nav = $('#tabbar'); if (!nav) return;
  const unread = state.alerts.filter((a) => a.relevant !== false && !state.prefs.dismissedAlerts.includes(a.id)).length;
  const tab = (key, label, ic, count) =>
    h('button', { class: `tab ${state.tab === key ? 'is-active' : ''}`, onclick: () => actions.setTab(key), 'aria-current': state.tab === key ? 'page' : null },
      h('span', { class: 'tab__icon' }, icon(ic, 22), count ? h('span', { class: 'tab__count' }, count) : null),
      h('span', { class: 'tab__label' }, label));
  nav.replaceChildren(tab('trip', 'Trip', 'bus'), tab('map', 'Map', 'pin'), tab('alerts', 'Alerts', 'bell', unread), tab('timetable', 'Times', 'clock'), tab('settings', 'Settings', 'settings'));
}

function renderFooter() {
  const bits = [];
  if (state.freshness?.lastSuccessAt) bits.push(`Updated ${fmtTime(state.freshness.lastSuccessAt)}`);
  if (TIME_OVERRIDE) bits.push('CLOCK PINNED');
  if (state.safeMode) bits.push('SAFE MODE');
  return h('footer', { class: 'footer' }, bits.join(' · '));
}

/** Absolute fallback: plain DOM, official timetable only. */
function renderSafe(err) {
  console.error('render failed; entering safe mode', err);
  state.safeMode = true;
  const root = $('#app');
  const now = nowMs();
  const key = state.direction === 'toCampus' ? 'C' : 'E';
  const table = tableFor(state.official, key, now);
  const stopId = state.direction === 'toCampus' ? state.prefs.homeStopId : CAMPUS_STOP;
  const times = table ? stopTimes(table, stopId, 'board', now) : [];
  const box = el('section', 'hero hero--empty');
  box.append(el('div', 'hero__kicker', 'Timetable (safe mode)'));
  box.append(el('div', 'hero__empty-title', `${ROUTES[key].name} from ${stopName(stopId)}`));
  box.append(el('div', 'hero__arrive', times.length ? times.join('  ·  ') : 'No published times today'));
  box.append(el('div', 'muted small', 'Something went wrong rendering live data. This is the published timetable. Tap to try again.'));
  const btn = el('button', 'btn btn--secondary', 'Try again');
  btn.onclick = () => { state.safeMode = false; render(); };
  box.append(btn);
  root.replaceChildren(box);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  installGlobalGuards((err) => { toast('Recovered from an error', 'warn'); if (!state.safeMode) renderSafe(err); });
  const applyHash = () => { const t = location.hash.replace('#', ''); if (TABS.includes(t)) { state.tab = t; render(); } };
  window.addEventListener('hashchange', applyHash);

  try {
    const [baked, official, walk] = await Promise.all([
      api.getSnapshot(), fetch('./data/official.json', { cache: 'no-cache' }).then((r) => r.json()), api.getWalkTimes(),
    ]);
    state.baked = baked; state.official = official; state.walk = walk;
  } catch {
    $('#app').replaceChildren(el('div', 'booting', 'Could not load timetable data. Check your connection and reopen.'));
    return;
  }

  state.tab = 'trip';
  applyHash();
  render();
  await computePushState();
  render();
  fast.start(); slow.start();
  state.booted = true;
  setInterval(() => { if (!document.hidden && state.tab === 'trip') render(); }, 10_000);
  // The map manages its own live updates; don't let the trip re-render loop touch it.
  setTimeout(() => refreshDirectory().catch(() => {}), 2500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

window.__stuy = { state, fast, slow, render, refreshDirectory, actions, derive: () => derive(nowMs()) };
boot();
