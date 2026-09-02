/** GPS-validation tests, incl. the real 2026-09-02 "stale 8 min" case. */
import { readFileSync } from 'node:fs';
import { classifyArrival, classifyArrivals, trustworthyArrivals, nearestStopIndex, haversine } from '../js/geo.js';
import { normalizeEta } from '../js/api.js';

const fx = JSON.parse(readFileSync(new URL('../test-fixtures/live-2026-09-02.json', import.meta.url)));
let pass = 0, fail = 0;
const ok = (n, c, note = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${note ? '  ' + note : ''}`); c ? pass++ : fail++; };
const check = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), JSON.stringify(g));

const sequence = fx.routeE_seq.map(([position, stopId]) => ({ position: String(position), stopId: String(stopId) }));
const stops = fx.stops;
const vehicles = Object.values(fx.buses.buses).flat().map((b) => ({ name: b.busName, routeName: b.route, lat: +b.latitude, lon: +b.longitude }));
const now = Date.parse(fx.capturedAt);
const eta = normalizeEta(fx.etaE17, '6566', now);

console.log('\n== fixture sanity ==');
ok('eta parsed as live tier with 3 arrivals', eta.tier === 'live' && eta.arrivals.length === 3, eta.arrivals.map((a) => a.vehicle).join(','));
ok('bus 2148 is the only one with live GPS', vehicles.filter((v) => v.routeName === 'Route E').map((v) => v.name).join(',') === '2148');

console.log('\n== bus 2148 GPS is past 1st Ave/17th ==');
const bus2148 = vehicles.find((v) => v.name === '2148');
const t17 = stops['6566'];
const { index: busIdx } = nearestStopIndex(bus2148.lat, bus2148.lon, sequence, stops);
const targetIdx = sequence.findIndex((x) => x.stopId === '6566');
ok('bus nearest-stop index is beyond the target index', busIdx > targetIdx, `bus@${busIdx} > target@${targetIdx}`);
ok('bus is >250m from 1st Ave/17th', haversine(bus2148.lat, bus2148.lon, t17.lat, t17.lon) > 250, `${Math.round(haversine(bus2148.lat, bus2148.lon, t17.lat, t17.lon))} m`);

console.log('\n== THE FIX: the stale "6/8 min" for 2148 is dropped ==');
const ctx = { vehicles, sequence, stops, targetStopId: '6566', now };
const c = classifyArrivals(eta.arrivals, ctx);
const a2148 = [...c.live, ...c.estimate, ...c.passed].find((a) => a.vehicle === '2148');
check('2148 classified as passed', a2148.confidence, 'passed');
ok('2148 is NOT in trustworthy arrivals', !trustworthyArrivals(eta.arrivals, ctx).some((a) => a.vehicle === '2148'));
ok('2146 / Spare 1 (no GPS) are estimates, not live', c.live.length === 0 && c.estimate.length === 2, `live=${c.live.length} est=${c.estimate.length} passed=${c.passed.length}`);

console.log('\n== synthetic: a bus genuinely approaching is kept as live ==');
const approaching = [{ name: '2199', routeName: 'Route E', lat: stops['6580'].lat, lon: stops['6580'].lon }]; // one stop before 6566
const synthEta = [{ arrivalAt: now + 4 * 60000, vehicle: '2199' }];
check('approaching bus → live', classifyArrival(synthEta[0], { vehicles: approaching, sequence, stops, targetStopId: '6566', now }).confidence, 'live');
const atStop = [{ name: '2200', routeName: 'Route E', lat: stops['6566'].lat + 0.0002, lon: stops['6566'].lon }];
check('bus sitting at the stop → live', classifyArrival({ arrivalAt: now + 60000, vehicle: '2200' }, { vehicles: atStop, sequence, stops, targetStopId: '6566', now }).confidence, 'live');

console.log('\n== reassigned bus: same name, different route now → not live ==');
const reassigned = [{ name: '2146', routeName: 'Route A', lat: stops['6580'].lat, lon: stops['6580'].lon }];
const rc = classifyArrival({ arrivalAt: now + 3 * 60000, vehicle: '2146' }, { vehicles: reassigned, sequence, stops, targetStopId: '6566', routeName: 'Route E', now });
check('2146-on-A is estimate, not live', rc.confidence, 'estimate');
ok('reason names the reassignment', /another route/.test(rc.reason), rc.reason);
ok('reassigned bus is NOT trustworthy', !trustworthyArrivals([{ arrivalAt: now + 3 * 60000, vehicle: '2146' }], { vehicles: reassigned, sequence, stops, targetStopId: '6566', routeName: 'Route E', now }).length);
const sameRoute = [{ name: '2146', routeName: 'Route E', lat: stops['6580'].lat, lon: stops['6580'].lon }];
check('same name ON Route E approaching → live', classifyArrival({ arrivalAt: now + 3 * 60000, vehicle: '2146' }, { vehicles: sameRoute, sequence, stops, targetStopId: '6566', routeName: 'Route E', now }).confidence, 'live');

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
