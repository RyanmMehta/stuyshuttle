/** Verification harness for the trip math. Run: node tools/test.mjs */
import { readFileSync } from 'node:fs';
import {
  parseClockTime, fmtClock, minutesUntil, buildDepartures, planTrip, heroFor,
  rideMinutesBetween, explainNoService, isWeekend, MIN, STALE_MS,
  servesOn, serviceDayLabel, LONG_WAIT_MIN, nyTime, nyParts, latenessMinutes,
} from '../js/schedule.js';
import { parseEtaText, normalizeEta } from '../js/api.js';
import { htmlToText, isRelevantAlert } from '../js/text.js';
import { buildLeaveEvents, buildIcs } from '../js/ics.js';

const snap = JSON.parse(readFileSync(new URL('../data/timetable.json', import.meta.url)));
const walk = JSON.parse(readFileSync(new URL('../data/walk.json', import.meta.url)));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const ok = (name, cond, note = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${note ? '  ' + note : ''}`); cond ? pass++ : fail++; };

// Fixed New York instants (independent of the machine's zone).
const WED = nyTime(2026, 8, 2, 7, 0);      // Wed 2026-09-02 07:00 ET
const FRI = nyTime(2026, 8, 4, 8, 0);
const SAT = nyTime(2026, 8, 5, 8, 0);

console.log('\n== New York time, machine-zone independent ==');
check('nyTime → ISO', new Date(WED).toISOString(), '2026-09-02T11:00:00.000Z');
check('winter (EST) 7:30 → 12:30Z', new Date(parseClockTime('7:30 AM', nyTime(2026, 11, 2, 6, 0))).toISOString(), '2026-12-02T12:30:00.000Z');
check('summer (EDT) 7:30 → 11:30Z', new Date(parseClockTime('7:30 AM', WED)).toISOString(), '2026-09-02T11:30:00.000Z');
check('nyParts dow Wed=3', nyParts(WED).dow, 3);

console.log('\n== time parsing ==');
check('parse 7:30 AM', fmtClock(parseClockTime('7:30 AM', WED)), '7:30 AM');
check('parse 12:40 PM', fmtClock(parseClockTime('12:40 PM', WED)), '12:40 PM');
check('parse 12:05 AM (midnight)', fmtClock(parseClockTime('12:05 AM', WED)), '12:05 AM');
check('garbage -> null', parseClockTime('soon'), null);

console.log('\n== countdown rounds DOWN ==');
check('4m59s reads as 4', minutesUntil(WED + 4 * MIN + 59_000, WED), 4);

console.log('\n== plan verification: 8:00 departure, walk 4, buffer 3 -> leave 7:53 ==');
const routeC = snap.schedules['74771'];
const seqC = snap.sequences['74771'];
const ride = rideMinutesBetween(routeC, '6556', '6545', seqC);
ok('ride 6556->6545 is estimated (no terminus timepoint)', ride.estimated === true, `${ride.minutes} min`);
const dep8 = parseClockTime('8:00 AM', WED);
const trip = planTrip({ departsAt: dep8, walkToStop: walk.homeToStop['6556'], buffer: 3, rideMinutes: ride.minutes, walkToBuilding: walk.stopToBuilding['6545'].stern, arrivalEstimated: ride.estimated, now: WED });
check('leave time', fmtClock(trip.leaveAt), '7:53 AM');
ok('not missed at 7:00', trip.missed === false && trip.tight === false);

console.log('\n== hero state machine ==');
const at = (h, m) => nyTime(2026, 8, 2, h, m);
const mk = (now) => [planTrip({ departsAt: dep8, walkToStop: 4, buffer: 3, rideMinutes: 17, walkToBuilding: 7, now })];
check('7:45 → wait, leave in 8', [heroFor(mk(at(7, 45)), at(7, 45)).mode, heroFor(mk(at(7, 45)), at(7, 45)).leaveIn], ['wait', 8]);
check('7:53 → NOW with full 3-min buffer left', [heroFor(mk(at(7, 53)), at(7, 53)).mode, mk(at(7, 53))[0].bufferLeftMinutes], ['now', 3]);
check('7:55 → NOW with 1 min buffer left', [heroFor(mk(at(7, 55)), at(7, 55)).mode, mk(at(7, 55))[0].bufferLeftMinutes], ['now', 1]);
check('7:57 → missed (4-min walk no longer fits)', [mk(at(7, 57))[0].missed, heroFor(mk(at(7, 57)), at(7, 57)).mode], [true, 'none']);

console.log('\n== dropoff choice: 715 Bway must beat 3rd Ave/13th ==');
const rideAlt = rideMinutesBetween(routeC, '6556', '6563', seqC);
const viaTerminus = ride.minutes + walk.stopToBuilding['6545'].stern;
const viaThird = rideAlt.minutes + walk.stopToBuilding['6563'].stern;
ok('715 Broadway is faster door-to-door', viaTerminus < viaThird, `${viaTerminus} min vs ${viaThird} min`);

console.log('\n== tier selection ==');
const liveEta = (arrivals, extra = {}) => ({ tier: 'live', arrivals, scheduleTimes: [], outOfService: false, ...extra });
check('live wins', buildDepartures({ eta: liveEta([{ arrivalAt: WED + 5 * MIN, vehicle: '2960', reportedAt: WED - 10_000 }]), now: WED }).tier, 'live');
check('stale live demoted to offline snapshot', buildDepartures({ eta: liveEta([{ arrivalAt: WED + 5 * MIN, vehicle: '2960', reportedAt: WED - STALE_MS - 1000 }]), fallbackTimes: ['8:00 AM'], offline: true, now: WED }).tier, 'offline');
check('scheduled when no bus', buildDepartures({ eta: { tier: 'scheduled', arrivals: [], scheduleTimes: ['8:00 AM', '8:30 AM'], outOfService: false }, now: WED }).tier, 'scheduled');
check('offline snapshot when network dead', buildDepartures({ eta: null, fallbackTimes: ['8:00 AM', '8:30 AM'], offline: true, now: WED }).tier, 'offline');
check('none when nothing at all', buildDepartures({ eta: null, fallbackTimes: [], now: WED }).tier, 'none');

console.log('\n== live list is padded with later scheduled departures ==');
const mix = buildDepartures({ eta: liveEta([{ arrivalAt: parseClockTime('8:02 AM', WED), vehicle: '2960', reportedAt: WED - 3000, stopsAway: 2 }], { scheduleTimes: ['8:00 AM', '8:30 AM', '9:10 AM'] }), now: WED });
check('one live + two scheduled', mix.departures.map((d) => (d.live ? 'L' : 'S') + fmtClock(d.at)), ['L8:02 AM', 'S8:30 AM', 'S9:10 AM']);
check('live entry knows it is 2 min late', mix.departures[0].late, 2);
check('lateness helper: 8:03 vs [8:00]', latenessMinutes(parseClockTime('8:03 AM', WED), ['7:30 AM', '8:00 AM'], WED), 3);

console.log('\n== NYU says out of service today → snapshot is NOT shown as running ==');
const oos = buildDepartures({ eta: { tier: 'none', arrivals: [], scheduleTimes: ['8:00 AM'], outOfService: true, reason: 'NYU reports this route out of service today' }, fallbackTimes: ['8:00 AM', '8:30 AM'], now: WED });
check('tier none', oos.tier, 'none');
ok('reason names NYU', /NYU/.test(oos.reason));

console.log('\n== live ETA text parsing (two live response shapes) ==');
check('"24 min "', parseEtaText('24 min '), 24);
check('"1h 11min "', parseEtaText('1h 11min '), 71);
check('"2 hrs 5 min"', parseEtaText('2 hrs 5 min'), 125);
check('"Arriving"', parseEtaText('Arriving'), 0);
check('"--" -> null', parseEtaText('--'), null);
check('"Route service starts at 7:30 AM" -> null', parseEtaText('Route service starts at 7:30 AM'), null);

console.log('\n== normalizeEta on real response shapes ==');
const n1 = normalizeEta({ ETAs: { '6547': [{ eta: '24 min ', busName: '2191', stopsAmount: 2, distance: '1.2mi', routeId: '74769', created: '2026-09-01 22:08:57' }] } }, '6547', WED);
check('string-only live shape → live, 2 stops away', [n1.tier, n1.arrivals[0].stopsAway], ['live', 2]);
const n2 = normalizeEta({ ETAs: { '0000': [{ outOfService: true, scheduleTimes: ['8:15 AM'], eta: 'no vehicles' }] } }, '6566');
check('weekend trap → none but times kept for display', [n2.tier, n2.outOfService, n2.scheduleTimes.length], ['none', true, 1]);
const n3 = normalizeEta({ ETAs: { '8801': [{ eta: '1h 11min ', arrivalTimestamp: 1788319203, busName: '2191', error: ['No valid GPS from the bus', 'Probably, bus is in detour / on yard', 7619] }] } }, '8801');
check('GPS-error entry flagged lowConfidence', n3.arrivals[0].lowConfidence, true);
check('…and buildDepartures rejects it', buildDepartures({ eta: n3, now: WED }).tier, 'none');

console.log('\n== ride time is never negative (loop-route trap) ==');
const routeE = snap.schedules['72946'];
const seqE = snap.sequences['72946'];
const homeRide = rideMinutesBetween(routeE, '6545', '6566', seqE);
ok('715 Bway -> First Ave 17th is positive and plausible', homeRide.minutes > 0 && homeRide.minutes < 40, `${homeRide.minutes} min`);

console.log('\n== always offers more than one departure; past ones dropped ==');
const multi = buildDepartures({ eta: null, fallbackTimes: routeC.stops[0].times, offline: true, now: WED });
ok('shows >=3 upcoming at 7:00 AM', multi.departures.length >= 3, `${multi.departures.length} found`);
check('first is 7:30', fmtClock(multi.departures[0].at), '7:30 AM');
check('at 10:00 AM only 10:30 remains', buildDepartures({ eta: null, fallbackTimes: routeC.stops[0].times, offline: true, now: at(10, 0) }).departures.map((d) => fmtClock(d.at)), ['10:30 AM']);

console.log('\n== service days (the Saturday/Friday trap) ==');
const SD = snap.serviceDays;
check('Route C runs Mon-Thu', serviceDayLabel(SD, '74771'), 'Mon–Thu');
check('Route E runs Mon-Fri', serviceDayLabel(SD, '72946'), 'Mon–Fri');
check('Route F runs Mon-Thu', serviceDayLabel(SD, '74772'), 'Mon–Thu');
ok('C does NOT run Saturday', servesOn(SD, '74771', SAT) === false);
ok('C does NOT run Friday', servesOn(SD, '74771', FRI) === false);
ok('C DOES run Wednesday', servesOn(SD, '74771', WED) === true);
ok('E DOES run Friday', servesOn(SD, '72946', FRI) === true);
ok('unknown route defaults to running', servesOn(SD, '99999', WED) === true);
ok('isWeekend(Sat)', isWeekend(new Date(SAT)) === true);

console.log('\n== CRITICAL: offline snapshot must not invent weekend service ==');
const satTimes = routeC.stops[0].times;
check('Saturday yields NO departures', buildDepartures({ eta: null, fallbackTimes: satTimes, offline: true, servesToday: servesOn(SD, '74771', SAT), now: SAT }).departures.length, 0);
check('Friday yields NO Route C departures', buildDepartures({ eta: null, fallbackTimes: satTimes, offline: true, servesToday: servesOn(SD, '74771', FRI), now: FRI }).departures.length, 0);

console.log('\n== empty states name the real reason ==');
ok('Saturday explained as weekend', /weekend/i.test(explainNoService(new Date(SAT), 'toCampus', { serviceDays: SD, routeId: '74771' }).title));
const friWhy = explainNoService(new Date(FRI), 'toCampus', { serviceDays: SD, routeId: '74771' });
ok('Friday explained as Friday', /Friday/i.test(friWhy.title), friWhy.title);
ok('Friday detail names the real days', /Mon–Thu/.test(friWhy.detail), friWhy.detail);
ok('12:30 PM homeward = midday gap', /Midday/.test(explainNoService(new Date(at(12, 30)), 'toHome').title));
ok('6:00 AM = before service', /7:30/.test(explainNoService(new Date(at(6, 0)), 'toCampus').title));
ok('outOfService on a normal service day → "NYU reports" (unexpected)', /NYU reports/.test(explainNoService(new Date(WED), 'toCampus', { serviceDays: SD, routeId: '74771', outOfService: true }).title));
ok('outOfService on a Friday → calm "No service on Fridays" (expected)', /Fridays/.test(explainNoService(new Date(FRI), 'toCampus', { serviceDays: SD, routeId: '74771', outOfService: true }).title));
ok('outOfService on a Saturday → "weekends"', /weekend/i.test(explainNoService(new Date(SAT), 'toCampus', { serviceDays: SD, routeId: '74771', outOfService: true }).title));
ok('8:00 AM weekday = service running (null)', explainNoService(new Date(at(8, 0)), 'toCampus') === null);
ok('LONG_WAIT_MIN is a sane 45', LONG_WAIT_MIN === 45);

console.log('\n== alert text + relevance ==');
check('html → text keeps line breaks', htmlToText('A<br><p>B</p>&amp;'), 'A\nB\n&');
ok('ferry alert is "other"', isRelevantAlert('NYU Langone Health Ferry 9/2 boat swap at BAT') === false);
ok('system-wide alert is relevant', isRelevantAlert('NYU Shuttle Service Resumes September 2') === true);
ok('ambiguous stays relevant', isRelevantAlert('Delays expected this afternoon') === true);
ok('mentions our route despite ferry → relevant', isRelevantAlert('Route C detour; use the ferry') === true);

console.log('\n== calendar alarms only on service days ==');
const ev = buildLeaveEvents({ snapshot: snap, routeId: '74771', stopId: '6556', walkToStop: 4, buffer: 3, rideMinutes: 17, walkToBuilding: 7, destinationName: 'Stern', onlyDepartures: ['8:00 AM'], weeks: 2, from: new Date(WED) });
const dows = new Set(ev.map((e) => nyParts(e.start.getTime()).dow));
ok('never Fri/Sat/Sun', ![0, 5, 6].some((d) => dows.has(d)), [...dows].join(','));
ok('ics ends cleanly', buildIcs({ events: ev }).trim().endsWith('END:VCALENDAR'));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
