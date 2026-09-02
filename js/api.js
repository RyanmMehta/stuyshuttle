/**
 * Passio GO API wrapper for NYU (system 1007).
 *
 * The API is undocumented but CORS-open (Access-Control-Allow-Origin: *), so we
 * call it straight from the browser — no backend, no proxy.
 *
 * Quirks verified against the live system (all of these bit us at least once):
 *   - `eta=3` WITH the stop's correct `position` → live vehicle ETAs and a
 *     trustworthy `outOfService`. WITHOUT `position` → the stop's whole-day
 *     `scheduleTimes` (but `outOfService` then reads true even on service
 *     days, so ignore it on that path). With the WRONG position → SQL error.
 *   - Live entries come in two shapes: some carry a unix `arrivalTimestamp`,
 *     others only a string like "24 min " / "1h 11min ". Handle both.
 *   - `schedule=4` intermittently returns `{"routes":[]}` for routes whose
 *     data is fine. Treat it as a hint, never the only source.
 *   - On weekends `outOfService: true` arrives alongside a populated
 *     `scheduleTimes`. The day check has to come first.
 */
import { htmlToText, isRelevantAlert } from './text.js';

const BASE = 'https://passiogo.com';
export const SYSTEM_ID = '1007';

// Passio wants *a* device id; it needn't be registered, but keeping it stable
// across loads avoids being treated as a brand-new client every time.
const DEVICE_ID = (() => {
  const KEY = 'stuyshuttle.deviceId';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = 'sw-' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'sw-' + Math.random().toString(36).slice(2, 8);
  }
})();

/** Abort anything that hangs so the UI can fall back instead of spinning. */
const TIMEOUT_MS = 8000;

async function request(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const post = (path, body) =>
  request(`${BASE}${path}&deviceId=${DEVICE_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = (path) => request(`${BASE}${path}&deviceId=${DEVICE_ID}`);

// ---------------------------------------------------------------------------
// Routes (ids change between semesters — resolve by name; see routes.js)
// ---------------------------------------------------------------------------

export async function getRoutes() {
  const raw = await post('/mapGetData.php?getRoutes=1', { systemSelected0: SYSTEM_ID, amount: 1 });
  return (raw || [])
    .filter((r) => String(r.userId) === SYSTEM_ID)
    .map((r) => ({ id: String(r.myid), name: r.name, shortName: r.shortName || null, color: r.color, outdated: r.outdated === '1' }));
}

/** Per-route ordered stop sequences (routeId → [{position, stopId}]); ids change, so refresh daily. */
export async function getStopSequences() {
  const raw = await post('/mapGetData.php?getStops=2', { s0: SYSTEM_ID, sA: 1 });
  const sequences = {};
  for (const [routeId, entry] of Object.entries(raw.routes || {})) {
    sequences[routeId] = entry.slice(2).map(([position, stopId]) => ({ position: String(position), stopId: String(stopId) }));
  }
  const stops = {};
  for (const s of Object.values(raw.stops || {})) stops[s.stopId] = { id: s.stopId, name: s.name, lat: s.latitude, lon: s.longitude };
  return { sequences, stops };
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

/** Live vehicle positions for the whole system. */
export async function getVehicles() {
  const raw = await post('/mapGetData.php?getBuses=1', { s0: SYSTEM_ID, sA: 1 });
  const out = [];
  for (const list of Object.values(raw.buses || {})) {
    for (const b of list) {
      out.push({
        deviceId: b.deviceId,
        name: b.busName || b.bus,
        routeId: String(b.routeId),
        routeName: b.route,
        lat: parseFloat(b.latitude),
        lon: parseFloat(b.longitude),
        heading: parseFloat(b.calculatedCourse),
        load: b.paxLoad,               // passengers aboard
        capacity: b.totalCap,
        outOfService: b.outOfService === 1,
        outdated: b.outdated === 1,
        reportedAt: b.created,         // "09:38 PM" — clock string, NY time
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export { isRelevantAlert };

const parseNy = (s) => (s ? Date.parse(s.replace(' ', 'T') + nyOffsetSuffix(s)) : null);

/**
 * Passio timestamps are New York wall-clock with no zone. Attach the right
 * offset for that date so they parse correctly on any device.
 */
function nyOffsetSuffix(s) {
  const guess = Date.parse(s.replace(' ', 'T') + 'Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(new Date(guess));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = /GMT([+-]\d{1,2})/.exec(tz);
  const hh = m ? String(Math.abs(+m[1])).padStart(2, '0') : '05';
  const sign = m && +m[1] >= 0 ? '+' : '-';
  return `${sign}${hh}:00`;
}

/** Active service alerts, newest first. */
export async function getAlerts() {
  const raw = await post('/goServices.php?getAlertMessages=1', {
    systemSelected0: SYSTEM_ID,
    amount: 1,
    routesAmount: 0,
  });
  const now = Date.now();
  return (raw.msgs || [])
    .map((m) => {
      const title = (m.name || '').trim();
      const body = htmlToText(m.html || m.gtfsAlertDescriptionText || '');
      return {
        id: String(m.id),
        title,
        body,
        // `from` is when the alert takes effect and is what Passio's own feed
        // displays as the alert's time; `created` is when it was authored.
        at: parseNy(m.from) || parseNy(m.created),
        createdAt: parseNy(m.created),
        to: parseNy(m.to),
        important: m.important === '1',
        routeId: m.routeId ? String(m.routeId) : null,
        relevant: isRelevantAlert(`${title} ${body}`),
      };
    })
    // Drop alerts whose window has closed.
    .filter((a) => !a.to || a.to > now)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---------------------------------------------------------------------------
// Schedules and ETAs
// ---------------------------------------------------------------------------

/**
 * Scheduled timetable for a route via `schedule=4`. Returns null when the
 * endpoint has nothing (which it sometimes does even for healthy routes).
 */
export async function getSchedule(routeId, stopId = null) {
  const path =
    `/mapGetData.php?schedule=4&routeId=${routeId}` +
    (stopId ? `&stopId=${stopId}` : '') +
    `&r=${Math.random()}`;
  const raw = await get(path);
  const route = raw?.routes?.['0'];
  if (!route || typeof route !== 'object' || !Array.isArray(route.routeStops)) return null;
  return {
    routeId: String(route.routeId),
    name: route.routeName,
    color: route.routeColor,
    stops: route.routeStops.map((st) => {
      const tp = st.timepoints || {};
      return {
        stopId: String(st.stopId),
        name: st.stopName,
        position: String(st.position),
        times: [...(tp.past || []), ...(tp.next || [])],
      };
    }),
  };
}

function fmtTimeline(d) {
  // Passio interprets timelineDatetime as New York wall-clock.
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Raw ETA call. `position` null → schedule mode; a number → live mode.
 * `when` (Date) uses Passio's timeline to ask about another moment.
 */
export async function getEtaRaw(stopId, routeId, position = null, when = null) {
  let path =
    `/mapGetData.php?eta=3&stopIds=${stopId}&routeId=${routeId}` +
    (position ? `&position=${position}` : '') +
    `&userId=${SYSTEM_ID}`;
  if (when) {
    path += `&timelineIsActive=1&timelineDatetime=${encodeURIComponent(fmtTimeline(when))}`;
  }
  return get(path);
}

/** Live ETA at a stop, normalized. */
export async function getEta(stopId, routeId, position, when = null) {
  const raw = await getEtaRaw(stopId, routeId, position, when);
  return normalizeEta(raw, stopId);
}

/**
 * Parse Passio's human ETA text into minutes.
 * "24 min " → 24, "1h 11min " → 71, "Arriving" → 0, "--" → null.
 */
export function parseEtaText(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  if (t === '--' || t === '' || t.startsWith('no ') || t.startsWith('route ') || t.startsWith('service ')) return null;
  if (t.startsWith('arriv') || t === 'now' || t === 'due') return 0;
  const hm = /(\d+)\s*h(?:r|our)?s?\s*(\d+)\s*min/.exec(t);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const h = /^(\d+)\s*h(?:r|our)?s?$/.exec(t);
  if (h) return parseInt(h[1], 10) * 60;
  // Passio also sends ranges ("1-2 min", "3-4 min"). Take the EARLIER bound:
  // for catching a bus, assuming it arrives sooner is the safe error.
  const range = /(\d+)\s*[-–]\s*(\d+)\s*min/.exec(t);
  if (range) return Math.min(parseInt(range[1], 10), parseInt(range[2], 10));
  const m = /(\d+)\s*min/.exec(t);
  if (m) return parseInt(m[1], 10);
  const bare = /^(\d+)$/.exec(t);
  if (bare) return parseInt(bare[1], 10);
  return null;
}

const LOW_CONFIDENCE = /no valid gps|detour|yard|not tracking|no gps/i;

/**
 * Collapse the ETA endpoint's several response shapes into one:
 *
 *   {
 *     tier: 'live' | 'scheduled' | 'none',
 *     arrivals: [{ arrivalAt, vehicle, routeId, reportedAt, error, lowConfidence,
 *                  stopsAway, distanceText }],
 *     scheduleTimes: [...clock strings for today],
 *     outOfService: boolean,   // trusted only when `position` was passed
 *     reason: string | null,
 *   }
 */
export function normalizeEta(raw, stopId, now = Date.now()) {
  const etas = raw?.ETAs || {};
  const live = etas[String(stopId)];
  const fallback = etas['0000']?.[0] || null;

  const scheduleTimes =
    (Array.isArray(live) && live[0]?.scheduleTimes) || fallback?.scheduleTimes || [];

  if (Array.isArray(live) && live.length) {
    const arrivals = live
      .filter((e) => !e.OOS)
      .map((e) => {
        // Three observed live shapes, most precise first:
        //   1. unix `arrivalTimestamp`
        //   2. a "solid" ETA anchored to the bus's assigned trip, with a UTC
        //      arrival string (seen on Route C: arrival "10:30:00" for the
        //      10:30 departure while the bus was still at 715 Broadway)
        //   3. only human text such as "8 min " / "1-2 min"
        const solidUtc = e.solidEta?.arrivalUtc ? Date.parse(e.solidEta.arrivalUtc.replace(' ', 'T') + 'Z') : NaN;
        const at = e.arrivalTimestamp
          ? e.arrivalTimestamp * 1000
          : Number.isFinite(solidUtc) ? solidUtc
          : Number.isFinite(+e.secondsSpent) && +e.secondsSpent > 0 && +e.secondsSpent < 86400 ? now + +e.secondsSpent * 1000
          : addMinutes(now, parseEtaText(e.eta));
        if (at === null || !Number.isFinite(at)) return null;
        const err = Array.isArray(e.error) && e.error.length ? String(e.error[0]) : null;
        const loadPct = /^(\d+)%$/.exec(String(e.paxLoadS || ''));
        return {
          arrivalAt: at,
          vehicle: e.busName || null,
          routeId: String(e.routeId),
          reportedAt: e.created ? parseNy(e.created) : null,
          error: err,
          lowConfidence: Boolean(err && LOW_CONFIDENCE.test(err)),
          // A solid ETA is Passio's schedule-anchored prediction for a tracked
          // bus's assigned trip — real vehicle, timetable-shaped arrival.
          solid: e.solid === 1 || e.solid === '1',
          stopsAway: Number.isFinite(+e.stopsAmount) ? +e.stopsAmount : null,
          distanceText: e.distance && e.distance !== '0mi' ? String(e.distance) : null,
          loadPct: loadPct ? +loadPct[1] : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.arrivalAt - b.arrivalAt);

    if (arrivals.length) {
      return { tier: 'live', arrivals, scheduleTimes, outOfService: false, reason: null };
    }
  }

  if (fallback) {
    if (fallback.outOfService === true) {
      return {
        tier: 'none', arrivals: [], scheduleTimes, outOfService: true,
        reason: 'NYU reports this route out of service today',
      };
    }
    if (scheduleTimes.length || fallback.scheduleTime) {
      return {
        tier: 'scheduled', arrivals: [], scheduleTimes, outOfService: false,
        reason: fallback.scheduleTime || null,
      };
    }
  }

  return { tier: 'none', arrivals: [], scheduleTimes, outOfService: false, reason: 'No upcoming arrivals' };
}

const addMinutes = (base, mins) => (mins === null ? null : base + mins * 60_000);

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

/** The baked offline snapshot — the floor when the network is gone. */
export async function getSnapshot() {
  const res = await fetch('./data/timetable.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('snapshot unavailable');
  return res.json();
}

export async function getWalkTimes() {
  const res = await fetch('./data/walk.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('walk times unavailable');
  return res.json();
}
