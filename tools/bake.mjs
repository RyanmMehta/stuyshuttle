#!/usr/bin/env node
/**
 * Regenerates data/timetable.json from the live Passio GO API.
 *
 * The snapshot is the app's offline floor and first paint. The app ALSO
 * re-checks NYU's timetable itself once a day (js/timetable.js), so this only
 * needs re-running when you want the shipped baseline updated — e.g. at the
 * start of a semester:
 *
 *   node tools/bake.mjs
 *
 * All the API quirks and the never-regress logic live in js/timetable.js and
 * js/api.js, shared with the app, so there is exactly one implementation.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshRouteTimetable, probeServiceDays, mergeServiceDays, nextServiceDate, dayProbe } from '../js/timetable.js';
import { htmlToText, isRelevantAlert } from '../js/text.js';
import { resolveRouteIds, ROUTES } from '../js/routes.js';
import { fetchOfficial } from './sheets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = `${ROOT}/data/timetable.json`;
const SEED = `${ROOT}/data/seed-times.json`;
const BASE = 'https://passiogo.com';
const SYSTEM_ID = '1007';
const DEVICE_ID = 'stuyshuttle-bake';
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Routes are resolved by NAME at bake time — Passio re-creates routes under
// new IDs between semesters (Route E: 72946 → 74768 on 2026-09-02).

async function post(path, body) {
  const res = await fetch(`${BASE}${path}&deviceId=${DEVICE_ID}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchRoutes() {
  const raw = await post('/mapGetData.php?getRoutes=1', { systemSelected0: SYSTEM_ID, amount: 1 });
  return raw.filter((r) => r.userId === SYSTEM_ID)
    .map((r) => ({ id: r.myid, name: r.name, shortName: r.shortName || null, color: r.color }));
}

async function fetchStopsAndSequences() {
  const raw = await post('/mapGetData.php?getStops=2', { s0: SYSTEM_ID, sA: 1 });
  // `stops` is deduplicated across routes; `routes` holds the true per-route order.
  const stops = {};
  for (const s of Object.values(raw.stops)) {
    stops[s.stopId] = { id: s.stopId, name: s.name, lat: s.latitude, lon: s.longitude };
  }
  const sequences = {};
  for (const [routeId, entry] of Object.entries(raw.routes || {})) {
    sequences[routeId] = entry.slice(2).map(([position, stopId]) => ({ position: String(position), stopId: String(stopId) }));
  }
  return { stops, sequences };
}

async function fetchAlerts() {
  const raw = await post('/goServices.php?getAlertMessages=1', { systemSelected0: SYSTEM_ID, amount: 1, routesAmount: 0 });
  return (raw.msgs || []).map((m) => {
    const title = (m.name || '').trim();
    const body = htmlToText(m.html || m.gtfsAlertDescriptionText || '');
    return { id: String(m.id), title, body, from: m.from, to: m.to, important: m.important === '1',
      routeId: m.routeId ? String(m.routeId) : null, relevant: isRelevantAlert(`${title} ${body}`) };
  });
}

const main = async () => {
  console.log('Baking timetable from live Passio GO API...\n');
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const seed = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : null;

  const [routes, { stops, sequences }, alerts] = await Promise.all([fetchRoutes(), fetchStopsAndSequences(), fetchAlerts()]);
  console.log(`  routes ${routes.length} · stops ${Object.keys(stops).length} · alerts ${alerts.length}`);
  const stopNames = Object.fromEntries(Object.values(stops).map((s) => [s.id, s.name]));
  const routeIds = resolveRouteIds(routes);
  console.log(`  route ids by name: ${Object.entries(routeIds).map(([k, v]) => `${k}=${v}`).join(' ')}\n`);

  console.log('Official timetables (nyu.edu Google Sheets):');
  let official = null;
  try { official = await fetchOfficial(stops, console.log); }
  catch (err) { console.log(`  FAILED: ${err.message} — keeping data/official.json as is`); }
  if (official) writeFileSync(`${ROOT}/data/official.json`, JSON.stringify(official, null, 1));
  console.log();

  const schedules = {}, serviceDays = {}, warnings = [];
  const ROUTES_OF_INTEREST = Object.values(ROUTES).map((r) => routeIds[r.key]).filter(Boolean);
  for (const routeId of ROUTES_OF_INTEREST) {
    const meta = routes.find((r) => r.id === routeId) || {};
    const prevDays = prev?.serviceDays?.[routeId];
    const { schedule, warnings: w } = await refreshRouteTimetable({
      routeId, sequence: sequences[routeId], stopNames, routeMeta: meta,
      prev: prev?.schedules?.[routeId] || null, seed,
      when: dayProbe(nextServiceDate(prevDays)), delayMs: 250,
    });
    warnings.push(...w.map((x) => `${meta.name || routeId}: ${x}`));
    if (!schedule) { console.log(`  ${meta.name || routeId}: no schedule published`); continue; }
    schedules[routeId] = schedule;

    const timed = schedule.stops.filter((s) => s.times.length);
    const probe = await probeServiceDays(routeId, timed[0].stopId, timed[0].position, { delayMs: 250 });
    serviceDays[routeId] = mergeServiceDays(prevDays, probe);
    if (probe.some((v) => v === null)) warnings.push(`${schedule.name}: some service-day probes failed; kept previous`);

    console.log(
      `  ${schedule.name}: ${timed.length}/${schedule.stops.length} stops timed, ${timed[0].times.length} trips` +
      `\n      runs ${serviceDays[routeId].map((r, i) => (r ? DAY[i] : null)).filter(Boolean).join(' ') || 'never'}` +
      `\n      first ${timed[0].name} — ${timed[0].times.join(', ')}`
    );
  }

  const snapshot = { generatedAt: new Date().toISOString(), systemId: SYSTEM_ID, warnings, routeIds, routes, stops, sequences, schedules, serviceDays, alerts };
  mkdirSync(`${ROOT}/data`, { recursive: true });
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote data/timetable.json${warnings.length ? ` (${warnings.length} note(s))` : ''}`);
  for (const w of warnings) console.log(`  - ${w}`);
};

main().catch((err) => { console.error('bake failed:', err.message); process.exit(1); });
