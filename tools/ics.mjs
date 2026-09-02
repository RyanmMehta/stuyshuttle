#!/usr/bin/env node
/**
 * Writes leave-times.ics -- a static calendar feed you subscribe to once.
 *
 * Subscribing (rather than importing) means it updates itself whenever you
 * re-bake and push. Run after tools/bake.mjs:
 *
 *   node tools/bake.mjs && node tools/ics.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcs, buildLeaveEvents } from '../js/ics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = JSON.parse(readFileSync(`${ROOT}/data/timetable.json`, 'utf8'));
const walk = JSON.parse(readFileSync(`${ROOT}/data/walk.json`, 'utf8'));

// Defaults matching the app's out-of-the-box settings. Change these if you
// change your settings in the app, then re-run.
const CONFIG = {
  routeId: '74771',   // Route C
  stopId: '6556',     // 20th Street At Loop Exit
  building: 'stern',
  buffer: 3,
  weeks: 16,
  // Which departures deserve an alarm. Route C leaves at 7:30, 8:00, 8:30,
  // 9:10, 9:50 and 10:30 -- set this to the one(s) you actually take.
  // null = every departure (noisy).
  usualDepartures: ['8:00 AM'],
};

const walkToStop = walk.homeToStop[CONFIG.stopId];
const walkToBuilding = walk.stopToBuilding['6545'][CONFIG.building];
const destinationName = walk.buildings[CONFIG.building].name;

// Ride time: last published timepoint on the route, plus the interpolated hop
// to the 715 Broadway terminus (Passio publishes no time there).
const sched = snapshot.schedules[CONFIG.routeId];
const timed = sched.stops.filter((s) => s.times.length);
const first = timed[0];
const last = timed[timed.length - 1];
const parse = (t) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim());
  let h = parseInt(m[1], 10);
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
};
const rideMinutes = parse(last.times[0]) - parse(first.times[0]) + 4;

const events = buildLeaveEvents({
  snapshot, ...CONFIG, walkToStop, walkToBuilding, rideMinutes, destinationName,
  onlyDepartures: CONFIG.usualDepartures,
});

const ics = buildIcs({
  events,
  alarmMinutesBefore: 0,
  calendarName: 'StuyShuttle — leave for the shuttle',
});

writeFileSync(`${ROOT}/leave-times.ics`, ics);
const days = new Set(events.map((e) => e.start.toDateString()));
console.log(
  `Wrote leave-times.ics\n` +
  `  ${events.length} alarms across ${days.size} service days (${CONFIG.weeks} weeks)\n` +
  `  ${sched.name} from ${first.name}, ride ${rideMinutes} min, ` +
  `walk ${walkToStop} + buffer ${CONFIG.buffer}\n` +
  `  first: ${events[0]?.start.toLocaleString('en-US')} — ${events[0]?.summary}`
);
