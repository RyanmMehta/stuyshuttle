/** Popup model: the map shows the same GPS-classified truth as the Trip tab. */
import { readFileSync } from 'node:fs';
import { stopPopupModel } from '../js/views/map.js';
import { normalizeEta } from '../js/api.js';
import { classifyArrivals } from '../js/geo.js';

const fx = JSON.parse(readFileSync(new URL('../test-fixtures/live-2026-09-02.json', import.meta.url)));
let pass = 0, fail = 0;
const ok = (n, c, note = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${note ? '  ' + note : ''}`); c ? pass++ : fail++; };
const check = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), JSON.stringify(g));

const sequence = fx.routeE_seq.map(([position, stopId]) => ({ position: String(position), stopId: String(stopId) }));
const vehicles = Object.values(fx.buses.buses).flat().map((b) => ({ name: b.busName, routeName: b.route, lat: +b.latitude, lon: +b.longitude }));
const now = Date.parse(fx.capturedAt);
const eta = normalizeEta(fx.etaE17, '6566', now);
const classified = classifyArrivals(eta.arrivals, { vehicles, sequence, stops: fx.stops, targetStopId: '6566', routeName: 'Route E', now });

console.log('\n== popup for 1st Ave/17th at capture time (bus 2148 had passed) ==');
const m = stopPopupModel({ classified, outOfService: eta.outOfService, scheduleTimes: eta.scheduleTimes }, now);
ok('bus 2148 shows as passed, not as a live ETA', m.rows.some((r) => r.bus === '2148' && r.kind === 'passed'));
ok('no live rows (nothing GPS-confirmed approaching)', !m.rows.some((r) => r.kind === 'live'));
ok('2146 / Spare 1 shown as estimates', m.rows.filter((r) => r.kind === 'estimate').length === 2, JSON.stringify(m.rows));

console.log('\n== out of service ==');
check('OOS → clear note, no rows', stopPopupModel({ outOfService: true }), { rows: [], note: 'Not running right now.' });

console.log('\n== nothing tracking → schedule note ==');
const none = stopPopupModel({ classified: { live: [], estimate: [], passed: [] }, scheduleTimes: ['3:27 PM'] }, now);
ok('note names next scheduled', /Next scheduled 3:27 PM/.test(none.note), none.note);

console.log('\n== a genuinely live bus shows a live row ==');
const liveClass = { live: [{ vehicle: '2199', arrivalAt: now + 4 * 60000 }], estimate: [], passed: [] };
check('live row with minutes', stopPopupModel({ classified: liveClass }, now).rows[0], { kind: 'live', bus: '2199', label: '4 min' });

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
