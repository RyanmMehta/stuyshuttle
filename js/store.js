/** Preferences + cached data, all in localStorage. No account, no sync. */

const KEY = 'stuyshuttle.prefs.v2';

const DEFAULTS = {
  homeStopId: '6556',        // 20th St at Loop Exit — north Stuytown
  building: 'stern',         // Stern / KMC
  walkToStop: 4,             // minutes; tune from real experience
  buffer: 3,                 // safety minutes
  usualDeparture: '8:00 AM', // which departure gets a calendar alarm
  notifyOtherServices: false,// push alerts for ferry/Brooklyn/commuter too?
  tab: 'trip',
  dismissedAlerts: [],
  seenAlertIds: [],
};

export function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (stored) return { ...DEFAULTS, ...stored };
    // Migrate from v1 if present.
    const v1 = JSON.parse(localStorage.getItem('stuyshuttle.prefs.v1') || 'null');
    return v1 ? { ...DEFAULTS, ...v1 } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

/**
 * Generic cache of the last good value for a named thing, with an age, so a
 * cold start with flaky network shows something real rather than jumping
 * straight to the baked snapshot.
 */
const CACHE_KEY = 'stuyshuttle.cache.v2';

function readAll() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}

export function cacheResponse(name, data) {
  try {
    const all = readAll();
    all[name] = { at: Date.now(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* quota or private mode — fine */ }
}

export function readCache(name, maxAgeMs = 12 * 60 * 60 * 1000) {
  const hit = readAll()[name];
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.data;
}

export function cacheAge(name) {
  const hit = readAll()[name];
  return hit ? Date.now() - hit.at : null;
}

/**
 * Live-refreshed timetable, layered over the baked snapshot. Kept separate so
 * a bad refresh can be discarded without touching prefs.
 */
const TT_KEY = 'stuyshuttle.timetable.v1';

export function loadTimetableOverlay() {
  try { return JSON.parse(localStorage.getItem(TT_KEY) || 'null') || { schedules: {}, serviceDays: {}, refreshedAt: {} }; }
  catch { return { schedules: {}, serviceDays: {}, refreshedAt: {} }; }
}

export function saveTimetableOverlay(overlay) {
  try { localStorage.setItem(TT_KEY, JSON.stringify(overlay)); } catch { /* ignore */ }
}
