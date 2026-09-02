/**
 * Multi-stop trip planning.
 *
 * "When do I leave, and when do I arrive?" — answered across EVERY boarding
 * stop around Stuytown on every route that runs today, not just one stop.
 * Each option is a concrete bus at a concrete stop; the hero is the one with
 * the earliest arrival you can still walk to, and ties go to whichever lets
 * you leave latest.
 */
import { MIN, planTrip, minutesUntil, parseClockTime } from './schedule.js';
import { trustworthyArrivals } from './geo.js';
import { tableFor, tripsBetween, TO_CAMPUS, TO_HOME, CAMPUS_STOP, stopName, ROUTES } from './routes.js';

/**
 * @returns options[] each: { route, stopId, alightId, departsAt, alightAt, arrivesAt, leaveAt,
 *                            walkToStop, walkToBuilding, rideMin, missed, tight, bufferLeftMinutes, live:false }
 */
export function planOptions({ direction, official, walk, prefs, now = Date.now() }) {
  const buffer = Number(prefs.buffer ?? 3);
  const building = prefs.building || 'stern';
  const opts = [];

  if (direction === 'toCampus') {
    const walkToBuilding = walk?.stopToBuilding?.[CAMPUS_STOP]?.[building] ?? 7;
    for (const c of TO_CAMPUS) {
      const table = tableFor(official, c.route, now);
      if (!table) continue;
      for (const stopId of c.stops) {
        const walkToStop = stopId === prefs.homeStopId ? Number(prefs.walkToStop) : walk?.homeToStop?.[stopId];
        if (walkToStop == null) continue;
        for (const t of tripsBetween(table, stopId, c.alight, now)) {
          if (t.departsAt < now - MIN) continue;
          opts.push(makeOption({ route: c.route, stopId, alightId: c.alight, t, walkToStop, walkToBuilding, buffer, now }));
        }
      }
    }
  } else {
    const walkToStop = walk?.stopToBuilding?.[CAMPUS_STOP]?.[building] ?? 7; // building → 715 Broadway
    const wanted = prefs.homeAlightStopId || '6566';
    for (const h of TO_HOME) {
      const table = tableFor(official, h.route, now);
      if (!table) continue;
      const alights = h.alights.includes(wanted) ? [wanted] : h.alights.slice(0, 1);
      for (const alightId of alights) {
        const walkHome = alightId === prefs.homeStopId ? Number(prefs.walkToStop) : walk?.homeToStop?.[alightId] ?? 8;
        for (const t of tripsBetween(table, h.board, alightId, now)) {
          if (t.departsAt < now - MIN) continue;
          opts.push(makeOption({ route: h.route, stopId: h.board, alightId, t, walkToStop, walkToBuilding: walkHome, buffer, now }));
        }
      }
    }
  }
  return opts;
}

function makeOption({ route, stopId, alightId, t, walkToStop, walkToBuilding, buffer, now }) {
  const trip = planTrip({
    departsAt: t.departsAt, walkToStop, buffer, rideMinutes: t.rideMin, walkToBuilding,
    arrivalEstimated: false, now,
  });
  return { route, stopId, alightId, alightAt: t.arrivesAt, rideMin: t.rideMin, tripIndex: t.tripIndex,
    stopLabel: stopName(stopId), alightLabel: stopName(alightId), walkToStop, walkToBuilding, buffer, ...trip };
}

/**
 * For the SAME bus, which boarding stop is better? A longer walk has to buy at
 * least as many minutes of later departure as it costs (and at least 3), or
 * it's noise. Close calls go to your own stop, then the shorter walk.
 */
export function preferOption(a, b, homeStopId = null) {
  if (!a) return b;
  if (!b) return a;
  if (a.missed !== b.missed) return a.missed ? b : a;
  const gain = (b.leaveAt - a.leaveAt) / MIN;       // > 0: b lets you leave later
  const extraWalk = b.walkToStop - a.walkToStop;    // > 0: b is a longer walk
  if (gain >= Math.max(3, extraWalk)) return b;
  if (-gain >= Math.max(3, -extraWalk)) return a;
  if (a.stopId === homeStopId) return a;
  if (b.stopId === homeStopId) return b;
  if (a.walkToStop !== b.walkToStop) return a.walkToStop < b.walkToStop ? a : b;
  return b.leaveAt > a.leaveAt ? b : a;
}

/**
 * Collapse to one option per bus: for a given route+trip, the stop that lets
 * you leave latest (arrival is identical). Missed stops on a trip are dropped
 * as long as some stop on that trip is still reachable.
 */
export function bestPerTrip(options, homeStopId = null) {
  const groups = new Map();
  for (const o of options) {
    const k = `${o.route}:${o.tripIndex}:${o.alightId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const out = [];
  for (const group of groups.values()) {
    const best = group.reduce((acc, o) => preferOption(acc, o, homeStopId), null);
    // Keep the other stops for this same bus, latest-leave first, so the UI
    // can say "or from 1st Ave at 17th, leave 7:50".
    const alternatives = group.filter((o) => o !== best && !o.missed).sort((a, b) => b.leaveAt - a.leaveAt);
    out.push({ ...best, alternatives });
  }
  return out;
}

/** The hero: earliest arrival among catchable buses; near-ties → your stop / shorter walk. */
export function chooseHero(options, now = Date.now(), homeStopId = null) {
  const buses = bestPerTrip(options, homeStopId);
  const live = buses.filter((o) => !o.missed).sort((a, b) => a.arriveAt - b.arriveAt);
  if (!live.length) {
    const last = [...buses].sort((a, b) => b.departsAt - a.departsAt)[0];
    return last ? { mode: 'missed', trip: last } : { mode: 'none', trip: null };
  }
  const earliest = live[0].arriveAt;
  const t = live.filter((o) => o.arriveAt - earliest <= MIN).reduce((acc, o) => preferOption(acc, o, homeStopId), null);
  return t.tight ? { mode: 'now', trip: t } : { mode: 'wait', trip: t, leaveIn: minutesUntil(t.leaveAt, now) };
}

/** Upcoming list: one row per bus, soonest departure first. */
export function upcomingRows(options, limit = 6, homeStopId = null) {
  return bestPerTrip(options, homeStopId).sort((a, b) => a.departsAt - b.departsAt).slice(0, limit);
}

/**
 * Overlay a GPS-validated live ETA on one option.
 *
 * This is the accuracy fix. Instead of trusting Passio's raw "N min" (which can
 * be a stale schedule-anchored guess for a bus that already drove past), we:
 *   1. keep only arrivals a real GPS position confirms are still approaching
 *      (geo.trustworthyArrivals drops "passed" buses and stale estimates);
 *   2. use the soonest such arrival as the real next bus;
 *   3. if none are trustworthy, DON'T invent one — return the schedule option
 *      unchanged (the UI labels it "not tracking yet").
 *
 * `scheduleTimesAtStop` (clock strings) lets us report lateness against the
 * nearest scheduled departure rather than whichever trip the option came from.
 */
export function applyLiveValidated(option, eta, geoCtx, scheduleTimesAtStop = [], now = Date.now()) {
  if (!option || !eta) return option;
  if (eta.tier !== 'live' || !eta.arrivals?.length) return option;
  const trust = trustworthyArrivals(eta.arrivals, { ...geoCtx, now });
  if (!trust.length) return { ...option, liveChecked: true }; // GPS says nothing is really coming
  const a = trust.find((x) => x.arrivalAt > now - 60_000) || trust[0];

  // Lateness vs the closest scheduled time at this stop (not the source trip).
  let late = null;
  const sched = scheduleTimesAtStop.map((t) => parseClockTime(t, now)).filter((x) => x !== null);
  if (sched.length) {
    const nearest = sched.reduce((b, ts) => (Math.abs(ts - a.arrivalAt) < Math.abs(b - a.arrivalAt) ? ts : b), sched[0]);
    if (Math.abs(nearest - a.arrivalAt) <= 20 * MIN) late = Math.round((a.arrivalAt - nearest) / MIN);
  }

  const trip = planTrip({
    departsAt: a.arrivalAt, walkToStop: option.walkToStop, buffer: option.buffer ?? 3,
    rideMinutes: option.rideMin, walkToBuilding: option.walkToBuilding, now,
    vehicle: a.vehicle, live: true, stopsAway: a.stopsAway, loadPct: a.loadPct, solid: a.solid, late,
  });
  return { ...option, ...trip, alightAt: a.arrivalAt + (option.alightAt - option.departsAt), live: true, liveChecked: true, confidence: a.confidence, scheduledDepartsAt: option.departsAt };
}

/** Back-compat shim (unused by the app now); kept so older tests don't break. */
export function applyLive(option, eta, now = Date.now()) {
  if (!option || !eta || eta.tier !== 'live' || !eta.arrivals?.length) return option;
  const a = eta.arrivals.find((x) => !x.lowConfidence && Math.abs(x.arrivalAt - option.departsAt) <= 20 * MIN);
  if (!a) return option;
  const shift = a.arrivalAt - option.departsAt;
  const trip = planTrip({ departsAt: a.arrivalAt, walkToStop: option.walkToStop, buffer: option.buffer ?? 3,
    rideMinutes: option.rideMin, walkToBuilding: option.walkToBuilding, now, vehicle: a.vehicle, live: true,
    stopsAway: a.stopsAway, loadPct: a.loadPct, solid: a.solid, late: Math.round(shift / MIN) });
  return { ...option, ...trip, alightAt: option.alightAt + shift, live: true, scheduledDepartsAt: option.departsAt };
}

export const routeColor = (key) => ROUTES[key]?.color || '#888';
