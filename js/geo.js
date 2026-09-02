/**
 * Geometry + GPS validation of ETAs.
 *
 * The problem this solves: Passio's `eta=3` returns "solid" ETAs — schedule-
 * anchored predictions that keep saying "6 min" even after a bus has physically
 * driven past your stop (its last recompute is minutes stale). Passio's own app
 * shows those stale numbers next to a live GPS dot that contradicts them, which
 * is why the times feel untrustworthy.
 *
 * Here we cross-check every ETA against the bus's real GPS position from
 * `getBuses`. If the matched bus has already passed the stop on the route, its
 * small ETA is a stale artifact and we drop it. That makes our numbers more
 * trustworthy than Passio's raw feed.
 */

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest stop-sequence index to a point, and the distance to it. */
export function nearestStopIndex(lat, lon, sequence, stops) {
  let idx = -1, best = Infinity;
  sequence.forEach((x, i) => {
    const s = stops[x.stopId];
    if (!s) return;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < best) { best = d; idx = i; }
  });
  return { index: idx, distanceM: best };
}

const normName = (n) => String(n || '').trim().toLowerCase();

/** When a bus is within this of the stop, treat it as arriving regardless of index. */
const AT_STOP_M = 250;
/** A solid estimate not recomputed within this many seconds is "stale". */
const STALE_ESTIMATE_MS = 180_000;

/**
 * Classify one arrival against live GPS.
 * confidence:
 *   'live'    — a tracked bus, GPS-confirmed approaching (trust the ETA)
 *   'passed'  — a tracked bus that GPS shows already past this stop (drop it)
 *   'estimate'— no live GPS for this bus, or a stale solid estimate (show, but flagged)
 */
export function classifyArrival(arrival, { vehicles = [], sequence = [], stops = {}, targetStopId, routeName = null, now = Date.now() }) {
  const target = stops[targetStopId];
  const targetIdx = sequence.findIndex((x) => x.stopId === targetStopId);
  // Match by bus name AND current route: a bus reassigned to another route
  // (e.g. 2146 moved from E to A) leaves a stale estimate on its old route's
  // feed. Its live position is on the OTHER route's geography, so it can't
  // confirm anything here — treat it as an unverified estimate, not live.
  const named = vehicles.find((v) => normName(v.name) === normName(arrival.vehicle));
  const bus = named && (!routeName || !named.routeName || normName(named.routeName) === normName(routeName)) ? named : null;

  if (!bus) {
    const stale = arrival.updatedAt && now - arrival.updatedAt > STALE_ESTIMATE_MS;
    const reassigned = named && !bus;
    return { ...arrival, confidence: 'estimate',
      reason: reassigned ? 'bus is on another route now · stale' : stale ? 'no live GPS · stale estimate' : 'no live GPS',
      unverified: true, busDistanceM: null };
  }

  const toTarget = target ? haversine(bus.lat, bus.lon, target.lat, target.lon) : Infinity;
  if (toTarget <= AT_STOP_M) return { ...arrival, confidence: 'live', reason: 'at the stop', busDistanceM: toTarget };

  const { index: busIdx } = nearestStopIndex(bus.lat, bus.lon, sequence, stops);
  // On the ordered route, a bus whose nearest stop is beyond the target has
  // driven past it; a "few minutes" ETA for it is stale (next loop is far off).
  if (targetIdx >= 0 && busIdx > targetIdx) {
    return { ...arrival, confidence: 'passed', reason: 'GPS shows it already passed', busDistanceM: toTarget, busIndex: busIdx, targetIndex: targetIdx };
  }
  return { ...arrival, confidence: 'live', reason: 'approaching', busDistanceM: toTarget, busIndex: busIdx, targetIndex: targetIdx };
}

/**
 * Classify all arrivals for a stop and split them.
 * @returns { live: [...], estimate: [...], passed: [...] } each sorted soonest-first
 */
export function classifyArrivals(arrivals, ctx) {
  const out = { live: [], estimate: [], passed: [] };
  for (const a of arrivals || []) out[classifyArrival(a, ctx).confidence].push(classifyArrival(a, ctx));
  for (const k of Object.keys(out)) out[k].sort((x, y) => x.arrivalAt - y.arrivalAt);
  return out;
}

/**
 * The trustworthy next arrivals at a stop: GPS-confirmed live buses first, then
 * fresh estimates. Buses GPS shows as passed are excluded entirely.
 */
export function trustworthyArrivals(arrivals, ctx) {
  const c = classifyArrivals(arrivals, ctx);
  const freshEstimates = c.estimate.filter((a) => !/stale/.test(a.reason || ''));  // drops reassigned + stale
  return [...c.live, ...freshEstimates].sort((x, y) => x.arrivalAt - y.arrivalAt);
}

/** Flatten routePoints ([[{lat,lng}...],...]) to Leaflet [[lat,lng],...] polylines. */
export function routePolylines(routePoints) {
  if (!Array.isArray(routePoints)) return [];
  return routePoints.map((seg) => (seg || []).map((p) => [parseFloat(p.lat), parseFloat(p.lng)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)));
}
