/** Tests for the official-timetable model and the multi-stop planner. */
import { readFileSync } from 'node:fs';
import { nyTime, fmtClock } from '../js/schedule.js';
import { ROUTES, resolveRouteIds, dayTypeFor, tableFor, stopTimes, tripsBetween, routesRunningOn, columnIndex } from '../js/routes.js';
import { planOptions, bestPerTrip, chooseHero, upcomingRows, applyLive } from '../js/planner.js';

const official = JSON.parse(readFileSync(new URL('../data/official.json', import.meta.url)));
const walk = JSON.parse(readFileSync(new URL('../data/walk.json', import.meta.url)));
let pass = 0, fail = 0;
const check = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}` + (ok ? '' : `\n        got  ${JSON.stringify(g)}\n        want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c, note = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${note ? '  ' + note : ''}`); c ? pass++ : fail++; };

const WED = nyTime(2026, 8, 2, 7, 45), FRI = nyTime(2026, 8, 4, 7, 45), SAT = nyTime(2026, 8, 5, 11, 0);
const prefs = { homeStopId: '6556', walkToStop: 4, buffer: 3, building: 'stern', homeAlightStopId: '6566' };

console.log('\n== route ids resolve by name, never by hardcode ==');
check('live list', resolveRouteIds([{ id: '74768', name: 'Route E' }, { id: '74771', name: 'Route C' }, { myid: '74774', name: 'Route W' }]), { C: '74771', E: '74768', W: '74774' });
check('unknown names ignored', resolveRouteIds([{ id: '1', name: 'Route Q' }]), {});

console.log('\n== day types ==');
check('C Wed → monthu', dayTypeFor('C', WED), 'monthu');
check('C Fri → null', dayTypeFor('C', FRI), null);
check('E Fri → fri', dayTypeFor('E', FRI), 'fri');
check('E Sat → null', dayTypeFor('E', SAT), null);
check('W Sat → weekend', dayTypeFor('W', SAT), 'weekend');
check('W Wed → null', dayTypeFor('W', WED), null);
check('routes running Wed', routesRunningOn(WED), ['C', 'E', 'F']);
check('routes running Fri', routesRunningOn(FRI), ['E']);
check('routes running Sat', routesRunningOn(SAT), ['W']);

console.log('\n== official tables ==');
const tC = tableFor(official, 'C', WED), tE = tableFor(official, 'E', WED), tEf = tableFor(official, 'E', FRI), tW = tableFor(official, 'W', SAT);
check('C: 20th St times', stopTimes(tC, '6556', 'board', WED), ['7:30 AM', '8:00 AM', '8:30 AM', '9:10 AM', '9:50 AM', '10:30 AM']);
check('C: 715 Broadway ARRIVALS (from the sheet, not interpolated)', stopTimes(tC, '6545', 'alight', WED), ['7:47 AM', '8:18 AM', '8:48 AM', '9:28 AM', '10:08 AM', '10:48 AM']);
const e17 = stopTimes(tE, '6566', 'board', WED);
check('E Mon–Thu: 30 departures at 1st Ave/17th', e17.length, 30);
check('E: 11:51 AM is there', e17.includes('11:51 AM'), true);
check('E: first/last', [e17[0], e17[29]], ['7:11 AM', '11:31 PM']);
check('E: 715 Broadway departure col ≠ arrival col', [columnIndex(tE, '6545', 'board'), columnIndex(tE, '6545', 'alight')], [0, 11]);
const eFri17 = stopTimes(tEf, '6566', 'board', FRI);
ok('E Friday is a different timetable', eFri17.length !== e17.length || eFri17[1] !== e17[1], `${eFri17.length} vs ${e17.length}; second ${eFri17[1]} vs ${e17[1]}`);
check('W weekend: 1st Ave/17th first departures', stopTimes(tW, '6566', 'board', SAT).slice(0, 3), ['11:00 AM', '12:15 PM', '1:30 PM']);

console.log('\n== tripsBetween is loop-safe and honours partial trips ==');
const home = tripsBetween(tE, '6545', '6566', WED);
check('E home: 715 Bway 7:00 → 1st Ave/17th 7:11 (11 min)', [home[0].depart, home[0].arrive, home[0].rideMin], ['7:00 AM', '7:11 AM', 11]);
const toCampusE = tripsBetween(tE, '6566', '6545', WED);
check('E to campus: 1st Ave/17th 7:11 → 715 Bway 7:39 (28 min, around the loop)', [toCampusE[0].depart, toCampusE[0].arrive, toCampusE[0].rideMin], ['7:11 AM', '7:39 AM', 28]);
ok('last E bus (11:31 PM) does NOT reach campus → excluded', !toCampusE.some((t) => t.depart === '11:31 PM'));
const from3rd = tripsBetween(tE, '13118', '6545', WED);
check('partial 7:30 trip boards at 3rd Ave/17th 7:32 → 7:39', [from3rd[0].depart, from3rd[0].arrive], ['7:32 AM', '7:39 AM']);
check('backwards pair is empty', tripsBetween(tE, '6567', '6566', WED).length, 0);
const cTrip = tripsBetween(tC, '6556', '6545', WED);
check('C: 20th St 8:00 → 715 Bway 8:18 (sheet arrival)', [cTrip[1].depart, cTrip[1].arrive, cTrip[1].rideMin], ['8:00 AM', '8:18 AM', 18]);

console.log('\n== planner: to campus on a Wednesday at 7:45 ==');
const opts = planOptions({ direction: 'toCampus', official, walk, prefs, now: WED });
ok('considers C and E', new Set(opts.map((o) => o.route)).size === 2, [...new Set(opts.map((o) => o.route))].join(','));
const hero = chooseHero(opts, WED, prefs.homeStopId);
check('hero = Route C 8:00 from 20th St (arrive 8:25 = 8:18 + 7 walk)', [hero.mode, hero.trip.route, hero.trip.stopId, fmtClock(hero.trip.departsAt), fmtClock(hero.trip.arriveAt), fmtClock(hero.trip.leaveAt)], ['wait', 'C', '6556', '8:00 AM', '8:25 AM', '7:53 AM']);
const rows = upcomingRows(opts, 8, prefs.homeStopId);
ok('rows are one-per-bus', new Set(rows.map((r) => `${r.route}:${r.tripIndex}`)).size === rows.length);
const eRow = rows.find((r) => r.route === 'E');
ok('an E row exists and its best stop is 3rd Ave/17th (leave 16 min later for the same bus)', eRow && eRow.stopId === '13118', eRow && `${eRow.stopLabel} ${fmtClock(eRow.departsAt)} leave ${fmtClock(eRow.leaveAt)}`);
ok('…with 1st Ave/17th offered as an alternative for that same bus', eRow && eRow.alternatives.some((a) => a.stopId === '6566'), eRow && eRow.alternatives.map((a) => `${a.stopLabel} ${fmtClock(a.departsAt)} leave ${fmtClock(a.leaveAt)}`).join(' | '));
const c8 = bestPerTrip(opts, prefs.homeStopId).find((o) => o.route === 'C' && fmtClock(o.arriveAt) === '8:25 AM');
check('for the 8:00 C bus, a 1-min gain does NOT move you off your home stop', c8.stopId, '6556');
ok('…but the other six Stuytown stops are listed as alternatives', c8.alternatives.length === 6, String(c8.alternatives.length));

console.log('\n== planner: Friday (no C) and Saturday (W only) ==');
const fri = planOptions({ direction: 'toCampus', official, walk, prefs, now: FRI });
check('Friday: only Route E options', [...new Set(fri.map((o) => o.route))], ['E']);
const friHero = chooseHero(fri, FRI, prefs.homeStopId);
ok('Friday hero exists and is E', friHero.mode === 'wait' && friHero.trip.route === 'E', `${friHero.trip?.stopLabel} ${fmtClock(friHero.trip?.departsAt)} → ${fmtClock(friHero.trip?.arriveAt)}`);
const sat = planOptions({ direction: 'toCampus', official, walk, prefs, now: SAT });
check('Saturday: Route W', [...new Set(sat.map((o) => o.route))], ['W']);
const satHome = planOptions({ direction: 'toHome', official, walk, prefs, now: SAT });
ok('Saturday home: W from 715 Broadway to 1st Ave/17th', satHome.length > 0 && satHome[0].route === 'W' && satHome[0].alightId === '6566');

console.log('\n== planner: home on a Wednesday at 6:00 PM ==');
const homeOpts = planOptions({ direction: 'toHome', official, walk, prefs, now: nyTime(2026, 8, 2, 18, 0) });
const hh = chooseHero(homeOpts, nyTime(2026, 8, 2, 18, 0), prefs.homeStopId);
check('hero home = E 6:10 PM from 715 Bway → 1st Ave/17th 6:21 (+8 walk = 6:29)', [hh.trip.route, fmtClock(hh.trip.departsAt), fmtClock(hh.trip.alightAt), fmtClock(hh.trip.arriveAt)], ['E', '6:10 PM', '6:21 PM', '6:29 PM']);

console.log('\n== live overlay ==');
const liveEta = { tier: 'live', arrivals: [{ arrivalAt: nyTime(2026, 8, 2, 8, 4), vehicle: '2119', stopsAway: 2, loadPct: 6 }] };
const withLive = applyLive(hero.trip, liveEta, WED);
check('live 8:04 replaces the 8:00 and marks 4 min late', [withLive.live, fmtClock(withLive.departsAt), withLive.late, withLive.vehicle], [true, '8:04 AM', 4, '2119']);
check('arrival shifts with it', fmtClock(withLive.arriveAt), '8:29 AM');
check('unrelated live bus (far from this trip) is ignored', applyLive(hero.trip, { tier: 'live', arrivals: [{ arrivalAt: nyTime(2026, 8, 2, 9, 30) }] }, WED).live, false);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
