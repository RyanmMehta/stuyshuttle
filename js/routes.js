/**
 * Routes, day types, and the official timetables.
 *
 * Passio route IDs are NOT stable — NYU re-created Route E under a new ID on
 * the first day of the Fall semester and the old one silently went empty. So
 * routes are identified here by NAME and resolved to today's ID at runtime.
 *
 * Timetables come from NYU's official Google Sheets (data/official.json, via
 * tools/sheets.mjs), which also carry the 715 Broadway ARRIVAL time the API
 * never publishes and the Friday / weekend variants it doesn't expose.
 */
import { parseClockTime, nyParts, MIN } from './schedule.js';

export const ROUTES = {
  C: { key: 'C', name: 'Route C', color: '#4169E1', days: { 1: 'monthu', 2: 'monthu', 3: 'monthu', 4: 'monthu' }, official: true },
  E: { key: 'E', name: 'Route E', color: '#CD5C5C', days: { 1: 'monthu', 2: 'monthu', 3: 'monthu', 4: 'monthu', 5: 'fri' }, official: true },
  W: { key: 'W', name: 'Route W', color: '#5B9BD5', days: { 0: 'weekend', 6: 'weekend' }, official: true },
  F: { key: 'F', name: 'Route F', color: '#3CB371', days: { 1: 'monthu', 2: 'monthu', 3: 'monthu', 4: 'monthu' }, official: false },
};
export const DAY_TYPE_LABEL = { monthu: 'Mon–Thu', fri: 'Friday', weekend: 'Sat–Sun' };
export const CAMPUS_STOP = '6545';

/** Short display names for the stops this app cares about. */
export const STOP_NAMES = {
  '6556': '20th St at Loop Exit', '6557': 'Ave C at 18th St', '6558': 'Ave C at 16th St',
  '6559': 'Ave C at 14th St', '6560': '14th St at Ave B', '6561': '14th St at Ave A',
  '6562': '14th St at 1st Ave', '6563': '3rd Ave at 13th St', '6545': '715 Broadway',
  '6564': '14th St at Irving Pl (EB)', '6580': '14th St at 3rd Ave', '6566': '1st Ave at 17th St',
  '6567': '1st Ave at 24th St', '6568': '1st Ave at 26th St', '13110': 'NYU Langone',
  '6570': 'Lexington at 31st St', '6571': 'Gramercy Green', '13118': '3rd Ave at 17th St',
  '6573': '14th St at Irving Pl (WB)', '6550': 'Broadway at Broome', '6551': '80 Lafayette',
  '9296': 'Cleveland Pl at Spring', '6553': 'Lafayette at E 4th',
};
export const stopName = (id) => STOP_NAMES[id] || id;

/** Boarding options around Stuytown, per direction. Order = preference for ties. */
export const TO_CAMPUS = [
  { route: 'C', stops: ['6556', '6557', '6558', '6559', '6560', '6561', '6562'], alight: CAMPUS_STOP },
  { route: 'E', stops: ['6566', '13118', '6573'], alight: CAMPUS_STOP },
  { route: 'W', stops: ['6566', '13118', '6573'], alight: CAMPUS_STOP },
];
export const TO_HOME = [
  { route: 'E', board: CAMPUS_STOP, alights: ['6566', '6567'] },
  { route: 'W', board: CAMPUS_STOP, alights: ['6566', '6567'] },
];

/** Map route key → current Passio id, from a route list ({id,name}) — live or baked. */
export function resolveRouteIds(routeList = []) {
  const ids = {};
  for (const r of Object.values(ROUTES)) {
    const hit = routeList.find((x) => String(x.name || '').trim().toLowerCase() === r.name.toLowerCase());
    if (hit) ids[r.key] = String(hit.id ?? hit.myid);
  }
  return ids;
}

export function dayTypeFor(key, ts = Date.now()) {
  const dow = nyParts(ts).dow;
  return ROUTES[key]?.days?.[dow] || null;
}

/** The official table for a route on the day containing `ts`, or null if it doesn't run. */
export function tableFor(official, key, ts = Date.now()) {
  const dt = dayTypeFor(key, ts);
  return dt ? official?.routes?.[key]?.[dt] || null : null;
}

/** Column index for a stop. `use` = 'board' prefers departure/stop, 'alight' prefers arrival/stop. */
export function columnIndex(table, stopId, use = 'board') {
  if (!table) return -1;
  const cols = table.columns;
  const pref = use === 'alight' ? ['arrival', 'stop', 'departure'] : ['departure', 'stop', 'arrival'];
  for (const kind of pref) {
    const i = cols.findIndex((c) => c.stopId === stopId && c.kind === kind);
    if (i >= 0) return i;
  }
  return -1;
}

/** All published times at a stop for boarding, sorted, as clock strings. */
export function stopTimes(table, stopId, use = 'board', onDay = Date.now()) {
  const i = columnIndex(table, stopId, use);
  if (i < 0) return [];
  return table.trips.map((t) => t[i]).filter(Boolean)
    .sort((a, b) => parseClockTime(a, onDay) - parseClockTime(b, onDay));
}

/**
 * Trips that carry you from `fromStopId` to `toStopId` on this table — both
 * cells published, and the alighting column strictly after the boarding one
 * (loop routes list 715 Broadway twice). Partial trips are handled naturally:
 * a bus that starts mid-route just has nulls before its first stop.
 */
export function tripsBetween(table, fromStopId, toStopId, onDay = Date.now()) {
  const fi = columnIndex(table, fromStopId, 'board');
  const ti = columnIndex(table, toStopId, 'alight');
  if (fi < 0 || ti < 0 || ti <= fi) return [];
  const out = [];
  table.trips.forEach((t, idx) => {
    if (!t[fi] || !t[ti]) return;
    const d = parseClockTime(t[fi], onDay), a = parseClockTime(t[ti], onDay);
    if (d === null || a === null || a <= d) return;
    out.push({ depart: t[fi], arrive: t[ti], departsAt: d, arrivesAt: a, rideMin: Math.round((a - d) / MIN), tripIndex: idx });
  });
  return out.sort((x, y) => x.departsAt - y.departsAt);
}

/** Which of our routes run on the day containing `ts`. */
export function routesRunningOn(ts = Date.now()) {
  return Object.values(ROUTES).filter((r) => dayTypeFor(r.key, ts)).map((r) => r.key);
}
