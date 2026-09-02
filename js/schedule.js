/**
 * Trip planning: turns raw arrivals into "leave at X, arrive at Y".
 *
 *   leaveHomeAt    = busAtMyStop − walkToStop − safetyBuffer
 *   arriveCampusAt = busAtDropoff + walkToBuilding
 *
 * Every clock string from Passio is New York wall-clock. All parsing here is
 * pinned to America/New_York, so the app is right even if the phone's zone is
 * wrong or you're looking at it from somewhere else.
 *
 * Rules that exist specifically so you don't miss a bus:
 *   - Countdowns round DOWN. "4 min" at 4m59s.
 *   - A live fix older than STALE_MS is demoted to the timetable; a confident
 *     wrong number is worse than an honest approximate one.
 *   - Passio's own low-confidence flags ("No valid GPS") are believed.
 *   - If NYU says out of service today, the timetable is NOT shown as if it
 *     were running.
 *   - Several departures are always offered, so one missed bus is survivable.
 */

export const MIN = 60_000;
export const STALE_MS = 90_000;
export const TERMINUS_OFFSET_MIN = 4;
export const LONG_WAIT_MIN = 45;
const NY = 'America/New_York';

export const ROUTES = {
  C: { key: 'C', id: '74771', name: 'Route C', color: '#4169E1', dropoff: '6545' },
  E: { key: 'E', id: '72946', name: 'Route E', color: '#CD5C5C', dropoff: '6545' },
  F: { key: 'F', id: '74772', name: 'Route F', color: '#3CB371', dropoff: '6545' },
};
export const ROUTE_BY_ID = Object.fromEntries(Object.values(ROUTES).map((r) => [r.id, r]));

/** Stops on the Stuytown side, in Route C order. */
export const HOME_STOPS = [
  { id: '6556', name: '20th St at Loop Exit', route: 'C' },
  { id: '6557', name: 'Avenue C at 18th St', route: 'C' },
  { id: '6558', name: 'Avenue C at 16th St', route: 'C' },
  { id: '6559', name: 'Avenue C at 14th St', route: 'C' },
  { id: '6560', name: '14th St at Avenue B', route: 'C' },
  { id: '6561', name: '14th St at Avenue A', route: 'C' },
  { id: '6562', name: '14th St at 1st Avenue', route: 'C' },
  { id: '6566', name: 'First Ave at 17th St', route: 'E' },
];

export const CAMPUS_STOPS = [{ id: '6545', name: '715 Broadway', routes: ['E', 'F'] }];

// ---------------------------------------------------------------------------
// New York time
// ---------------------------------------------------------------------------

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar parts of an instant, as seen in New York. */
export function nyParts(ts = Date.now()) {
  const p = PARTS_FMT.formatToParts(new Date(ts)).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return {
    y: +p.year, mo: +p.month - 1, d: +p.day,
    h: +p.hour % 24, mi: +p.minute, s: +p.second,
    dow: DOW[p.weekday] ?? new Date(ts).getDay(),
    minutesOfDay: (+p.hour % 24) * 60 + +p.minute,
  };
}

function nyOffsetMin(ts) {
  const p = nyParts(ts);
  return Math.round((Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - ts) / MIN);
}

/** The instant at which New York wall-clock reads y-mo-d h:mi. */
export function nyTime(y, mo, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let ts = guess - nyOffsetMin(guess) * MIN;
  const off2 = nyOffsetMin(ts);
  if (off2 !== nyOffsetMin(guess)) ts = guess - off2 * MIN; // DST boundary
  return ts;
}

/**
 * Parse Passio's "7:30 AM" into an instant on the New York calendar day that
 * contains `onDay`. Returns null for unparseable input.
 */
export function parseClockTime(str, onDay = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(str).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  const p = nyParts(onDay instanceof Date ? onDay.getTime() : onDay);
  return nyTime(p.y, p.mo, p.d, h, min);
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: NY });
}

/** Round DOWN: better to think you have less time than you do. */
export function minutesUntil(ts, now = Date.now()) {
  return Math.floor((ts - now) / MIN);
}

export function isWeekend(d = new Date()) {
  const dow = nyParts(d instanceof Date ? d.getTime() : d).dow;
  return dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Service days
// ---------------------------------------------------------------------------

/**
 * Does `routeId` run on `date`? `serviceDays[routeId]` is a 7-array, index 0 =
 * Sunday. Defaults to true when unknown, so a missing probe never hides a bus.
 */
export function servesOn(serviceDays, routeId, date = new Date()) {
  const days = serviceDays?.[routeId];
  if (!Array.isArray(days) || days.length !== 7) return true;
  const dow = nyParts(date instanceof Date ? date.getTime() : date).dow;
  return days[dow] !== false;
}

/** "Mon–Thu", "Mon–Fri", or a list. */
export function serviceDayLabel(serviceDays, routeId) {
  const days = serviceDays?.[routeId];
  if (!Array.isArray(days) || days.length !== 7) return null;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const on = days.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return null;
  const contiguous = on.every((v, i) => i === 0 || v === on[i - 1] + 1);
  return contiguous && on.length > 1
    ? `${names[on[0]]}–${names[on[on.length - 1]]}`
    : on.map((i) => names[i]).join(', ');
}

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

/**
 * Minutes late (+) or early (−) a live arrival is versus the nearest scheduled
 * time today, or null if nothing is within 20 minutes of it.
 */
export function latenessMinutes(arrivalAt, scheduleTimes = [], onDay = arrivalAt) {
  let best = null;
  for (const t of scheduleTimes) {
    const ts = parseClockTime(t, onDay);
    if (ts === null) continue;
    const diff = Math.round((arrivalAt - ts) / MIN);
    if (Math.abs(diff) <= 20 && (best === null || Math.abs(diff) < Math.abs(best))) best = diff;
  }
  return best;
}

/**
 * Build the list of upcoming departures at a stop from the best available
 * tier, labelling which one was used.
 *
 * Returns { tier, label, departures: [{ at, vehicle, live, stopsAway, late }], reason }.
 */
export function buildDepartures({
  eta, fallbackTimes = [], offline = false, servesToday = true, now = Date.now(),
}) {
  // Day gate first. The API returns outOfService:true WITH a populated
  // scheduleTimes on weekends; anything reading times before checking the day
  // shows service that doesn't exist.
  if (!servesToday) {
    return { tier: 'none', label: 'No service', departures: [], reason: 'Not running today' };
  }
  // NYU explicitly says no service today: do not show the timetable as if it
  // were running. (Trusted because live calls always pass the true position.)
  if (eta?.outOfService === true) {
    return { tier: 'none', label: 'No service', departures: [], reason: eta.reason || 'Out of service today' };
  }

  const todaysTimes = eta?.scheduleTimes?.length ? eta.scheduleTimes : fallbackTimes;

  // Tier 1: live, fresh, confident.
  if (eta?.tier === 'live' && eta.arrivals.length) {
    const fresh = eta.arrivals.filter((a) => {
      if (a.lowConfidence) return false;
      if (a.error && /no valid gps|detour|yard/i.test(a.error)) return false;
      return !a.reportedAt || now - a.reportedAt < STALE_MS;
    });
    if (fresh.length) {
      const live = fresh
        .filter((a) => a.arrivalAt > now - MIN)
        .map((a) => ({
          at: a.arrivalAt, vehicle: a.vehicle, live: true,
          stopsAway: a.stopsAway ?? null,
          late: latenessMinutes(a.arrivalAt, todaysTimes, now),
        }));
      // Pad with later scheduled departures so a single tracked bus doesn't
      // collapse the list to one entry.
      const lastLive = live.length ? live[live.length - 1].at : now;
      const later = toFutureDepartures(todaysTimes, now).filter(
        (d) => d.at > lastLive + 4 * MIN && !live.some((l) => Math.abs(l.at - d.at) < 6 * MIN)
      );
      return { tier: 'live', label: 'Live', departures: [...live, ...later], reason: null };
    }
    // Every fix stale/unreliable — fall through to the timetable.
  }

  // Tier 2: the API's own schedule for today.
  if (eta?.scheduleTimes?.length) {
    const departures = toFutureDepartures(eta.scheduleTimes, now);
    if (departures.length) return { tier: 'scheduled', label: 'Scheduled', departures, reason: null };
  }

  // Tier 3: the baked / cached snapshot.
  if (fallbackTimes.length) {
    const departures = toFutureDepartures(fallbackTimes, now);
    if (departures.length) {
      return {
        tier: offline ? 'offline' : 'scheduled',
        label: offline ? 'Offline timetable' : 'Scheduled',
        departures, reason: null,
      };
    }
  }

  return { tier: 'none', label: 'No service', departures: [], reason: eta?.reason || null };
}

function toFutureDepartures(clockStrings, now) {
  return clockStrings
    .map((t) => parseClockTime(t, now))
    .filter((ts) => ts !== null && ts > now - MIN)
    .sort((a, b) => a - b)
    .map((ts) => ({ at: ts, vehicle: null, live: false, stopsAway: null, late: null }));
}

// ---------------------------------------------------------------------------
// The trip
// ---------------------------------------------------------------------------

export function planTrip({
  departsAt, walkToStop, buffer, rideMinutes, walkToBuilding,
  arrivalEstimated = false, now = Date.now(), vehicle = null, live = false,
  stopsAway = null, late = null,
}) {
  const leaveAt = departsAt - (walkToStop + buffer) * MIN;
  const arriveAt = departsAt + (rideMinutes + walkToBuilding) * MIN;
  const walkDeadline = departsAt - walkToStop * MIN; // last instant you can still walk it
  return {
    departsAt, leaveAt, arriveAt, arrivalEstimated, vehicle, live, stopsAway, late,
    leaveInMinutes: minutesUntil(leaveAt, now),
    // Physically can't make it any more.
    missed: walkDeadline <= now,
    // Inside the buffer window: leave now; the buffer is what's being spent.
    tight: leaveAt <= now && walkDeadline > now,
    // How much of the buffer remains once you're inside it (rounded down).
    bufferLeftMinutes: Math.max(0, minutesUntil(walkDeadline, now)),
  };
}

/** Which trip the hero should show, and how urgently. */
export function heroFor(trips, now = Date.now()) {
  for (const t of trips) {
    if (t.missed) continue;
    if (t.tight) return { mode: 'now', trip: t };
    return { mode: 'wait', trip: t, leaveIn: minutesUntil(t.leaveAt, now) };
  }
  return { mode: 'none', trip: null };
}

/**
 * Ride time between two stops, from a timetable. Never negative; null when it
 * can't be determined honestly.
 */
export function rideMinutesBetween(schedule, fromStopId, toStopId, sequence = null) {
  if (!schedule) return { minutes: null, estimated: true };
  const from = schedule.stops.find((s) => s.stopId === fromStopId);
  const to = schedule.stops.find((s) => s.stopId === toStopId);
  if (!from || !from.times.length) return { minutes: null, estimated: true };

  if (to && to.times.length) {
    const d = medianForwardGap(from.times, to.times);
    if (d !== null && d > 0 && d < 120) return { minutes: d, estimated: false };
  }

  // Destination publishes no times (Route C's 715 Broadway terminus). Only
  // interpolate when it truly is the end of the line — on a loop, the "last
  // timed stop" can be earlier in clock time than the boarding stop.
  const seq = sequence || [];
  const isTerminus = seq.length ? seq[seq.length - 1]?.stopId === toStopId : false;
  if (isTerminus) {
    const timed = schedule.stops.filter((s) => s.times.length);
    const last = timed[timed.length - 1];
    if (last) {
      const base = medianForwardGap(from.times, last.times);
      if (base !== null && base >= 0 && base < 120) {
        return { minutes: base + TERMINUS_OFFSET_MIN, estimated: true };
      }
    }
  }
  return { minutes: null, estimated: true };
}

function medianForwardGap(aTimes, bTimes) {
  const day = Date.now();
  const A = aTimes.map((t) => parseClockTime(t, day)).filter((t) => t !== null);
  const B = bTimes.map((t) => parseClockTime(t, day)).filter((t) => t !== null).sort((x, y) => x - y);
  if (!A.length || !B.length) return null;
  const gaps = [];
  for (const a of A) {
    const next = B.find((b) => b > a);
    if (next !== undefined) gaps.push(Math.round((next - a) / MIN));
  }
  if (!gaps.length) return null;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

// ---------------------------------------------------------------------------
// Explaining an empty screen
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Why there is nothing to show, in words. Returns null when service is
 * expected to be running.
 */
export function explainNoService(now = new Date(), direction = 'toCampus', ctx = {}) {
  const ts = now instanceof Date ? now.getTime() : now;
  const { serviceDays, routeId, outOfService } = ctx;
  const p = nyParts(ts);
  const label = routeId ? serviceDayLabel(serviceDays, routeId) : null;

  // A day the route is known not to run is expected, and should read calmly.
  // "NYU reports no service" is reserved for a day it normally WOULD run.
  if (routeId && serviceDays && !servesOn(serviceDays, routeId, ts)) {
    if (p.dow === 0 || p.dow === 6) {
      return {
        title: 'No shuttle service on weekends',
        detail: `NYU shuttles run weekdays only${label ? ` (this route: ${label})` : ''}. Subway options below.`,
      };
    }
    return {
      title: `No service on ${DAY_NAMES[p.dow]}s`,
      detail: label ? `This route runs ${label} only. Check the other direction, or take the subway.` : 'This route does not run today.',
    };
  }
  if (p.dow === 0 || p.dow === 6) {
    return { title: 'No shuttle service on weekends', detail: 'NYU shuttles run weekdays only. Subway options below.' };
  }
  if (outOfService) {
    return {
      title: 'NYU reports no service today',
      detail: `The live system says this route is out of service today${label ? ` (it normally runs ${label})` : ''}. Check Alerts, and use the subway.`,
    };
  }

  const mins = p.minutesOfDay;
  if (direction === 'toCampus') {
    if (mins < 7 * 60 + 30) return { title: 'Route C starts at 7:30 AM', detail: 'First shuttle leaves 20th St at Loop Exit at 7:30 AM.' };
    if (mins > 10 * 60 + 43) {
      return {
        title: 'Route C is finished for today',
        detail: 'Route C runs mornings only (7:30–10:43 AM). Take the subway, or walk to Route E or F.',
      };
    }
  } else {
    if (mins > 11 * 60 + 45 && mins < 16 * 60 + 36) {
      return {
        title: 'Midday service gap',
        detail: 'No shuttle runs toward Stuytown between about 11:45 AM and 4:36 PM. Subway options below.',
      };
    }
    if (mins > 21 * 60 + 20) {
      return { title: 'Shuttles have stopped for the night', detail: 'Last Route E toward Stuytown leaves campus around 8:15 PM.' };
    }
  }
  return null;
}

/** Static subway fallback for when no shuttle is running. */
export const SUBWAY_FALLBACK = [
  { label: '6 train', detail: '23rd St & Park Ave S → Astor Place, then walk 6 min to Stern.', walkTo: 9 },
  { label: 'L train', detail: '1st Ave & 14th St → Union Sq, transfer N/R/W to 8th St.', walkTo: 12 },
  { label: 'M14A/D SBS', detail: '14th St crosstown → University Place, walk 5 min.', walkTo: 8 },
];
