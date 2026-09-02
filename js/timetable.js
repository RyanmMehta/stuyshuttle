/**
 * Live timetable refresh — the same logic for the app and the bake script, so
 * "never regress" is implemented exactly once.
 *
 * Why this exists: NYU changes schedules between semesters and for holidays,
 * and the Passio backend intermittently drops a stop's schedule for hours at a
 * time. A snapshot baked once would drift; a naive live fetch would sometimes
 * lose stops. This module fetches live, keeps whatever it already had when the
 * live answer is empty, and reports what it did.
 *
 * Source of truth for a stop's whole-day times is `eta=3` with `position`
 * OMITTED and a timeline set to 04:00 on a service day (see api.js quirks).
 */
import { getEtaRaw, getSchedule } from './api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whole-day scheduled times at one stop, on the given day. */
export async function fetchStopDayTimes(routeId, stopId, when, { tries = 3, delayMs = 0 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const raw = await getEtaRaw(stopId, routeId, null, when);
      const entry = Object.values(raw?.ETAs || {})[0]?.[0];
      const times = entry?.scheduleTimes || [];
      if (delayMs) await sleep(delayMs);
      if (times.length) return times;
    } catch { /* retry */ }
    if (i < tries - 1) await sleep(700 * (i + 1));
  }
  return [];
}

/** 04:00 New York time on `date` — early enough that nothing has departed. */
export function dayProbe(date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((o, x) => ((o[x.type] = x.value), o), {});
  // Build 04:00 NY as a real instant: local-noon guess, then use the NY parts.
  const d = new Date(`${p.year}-${p.month}-${p.day}T04:00:00`);
  // `d` is 04:00 in the *device* zone; shift by the NY/device offset difference.
  const nyOff = offsetMinutes(d, 'America/New_York');
  const devOff = -d.getTimezoneOffset();
  return new Date(d.getTime() + (devOff - nyOff) * 60_000);
}

function offsetMinutes(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((o, x) => ((o[x.type] = x.value), o), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The next date (today or later) on which `serviceDays[dow]` is true. */
export function nextServiceDate(serviceDays, from = new Date()) {
  const days = Array.isArray(serviceDays) && serviceDays.length === 7 ? serviceDays : [0, 1, 1, 1, 1, 1, 0];
  for (let i = 0; i < 14; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const dow = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
      .format(d).replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (m) => 'Sun Mon Tue Wed Thu Fri Sat'.split(' ').indexOf(m));
    if (days[dow]) return d;
  }
  return from;
}

/**
 * Build a route's timetable: try the cheap whole-route call, then walk the
 * stop sequence per stop, keeping previous/seed data wherever live is empty.
 *
 * @returns {{ schedule, warnings: string[], changed: boolean }}
 */
export async function refreshRouteTimetable({
  routeId, sequence, stopNames = {}, routeMeta = {}, prev = null, seed = null,
  when, delayMs = 0, onProgress = () => {},
}) {
  const warnings = [];
  const seen = new Set();
  const ordered = (sequence || []).filter(({ stopId }) => !seen.has(stopId) && seen.add(stopId));
  if (!ordered.length) return { schedule: prev, warnings: ['no stop sequence'], changed: false };

  // Fast path: one call for the whole route. Trust it only if it has times.
  let whole = null;
  try { whole = await getSchedule(routeId); } catch { /* fall through */ }
  const wholeTimes = new Map();
  if (whole?.stops?.some((s) => s.times.length)) {
    for (const s of whole.stops) if (s.times.length) wholeTimes.set(s.stopId, s.times);
  }

  const stops = [];
  let i = 0;
  for (const { stopId, position } of ordered) {
    onProgress(++i, ordered.length);
    let times = wholeTimes.get(stopId) || [];
    let source = times.length ? 'live' : null;

    if (!times.length) {
      times = await fetchStopDayTimes(routeId, stopId, when, { delayMs });
      if (times.length) source = 'live';
    }
    if (!times.length) {
      const before = prev?.stops?.find((s) => s.stopId === stopId)?.times;
      if (before?.length) {
        times = before; source = 'previous';
        warnings.push(`${stopNames[stopId] || stopId}: live empty, kept previous times`);
      }
    }
    if (!times.length && seed?.[routeId]?.[stopId]?.times?.length) {
      times = seed[routeId][stopId].times; source = 'seed';
      warnings.push(`${stopNames[stopId] || stopId}: live empty, used verified seed (${seed._verifiedOn || '?'})`);
    }
    stops.push({
      stopId, position: String(position),
      name: stopNames[stopId] || whole?.stops?.find((s) => s.stopId === stopId)?.name || stopId,
      times, source: source || 'none',
    });
  }

  if (!stops.some((s) => s.times.length)) {
    return { schedule: prev, warnings: [...warnings, 'no times at all; kept previous schedule'], changed: false };
  }

  const schedule = {
    routeId: String(routeId),
    name: routeMeta.name || prev?.name || whole?.name || `Route ${routeId}`,
    color: routeMeta.color || prev?.color || whole?.color || '#888',
    stops,
    refreshedAt: new Date().toISOString(),
  };
  const changed = JSON.stringify(prev?.stops?.map((s) => [s.stopId, s.times])) !==
                  JSON.stringify(stops.map((s) => [s.stopId, s.times]));
  return { schedule, warnings, changed };
}

/**
 * Which weekdays a route runs, probed with the stop's TRUE position (the only
 * mode in which `outOfService` is trustworthy). Index 0 = Sunday.
 */
export async function probeServiceDays(routeId, stopId, position, { from = new Date(), delayMs = 0 } = {}) {
  const days = new Array(7).fill(null);
  for (let i = 0; i < 7; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const nine = new Date(dayProbe(d).getTime() + 5 * 3_600_000); // 09:00 NY
    const dow = new Date(nine.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
    try {
      const raw = await getEtaRaw(stopId, routeId, position, nine);
      const entry = Object.values(raw?.ETAs || {})[0]?.[0];
      days[dow] = entry ? entry.outOfService !== true : null;
    } catch { days[dow] = null; }
    if (delayMs) await sleep(delayMs);
  }
  // A probe that failed (null) must not be mistaken for "no service".
  return days;
}

/** Merge a fresh probe over the previous one, ignoring failed (null) days. */
export function mergeServiceDays(prev, fresh) {
  const base = Array.isArray(prev) && prev.length === 7 ? [...prev] : [false, true, true, true, true, true, false];
  if (!Array.isArray(fresh)) return base;
  fresh.forEach((v, i) => { if (v === true || v === false) base[i] = v; });
  return base;
}
