/**
 * Generates an iCalendar feed of "leave home now" alarms.
 *
 * This exists because iOS web push is best-effort: Apple throttles background
 * delivery to home-screen web apps, so a push can arrive late or not at all.
 * Native calendar alarms fire on time, offline, every time. Push tells you
 * about disruptions; this tells you about the routine.
 *
 * Shared by the app's download button and tools/ics.mjs (which writes a static
 * file you can subscribe to so it updates itself).
 */

const PROD_ID = '-//StuyShuttle//NYU Stuytown Shuttle//EN';

/** ICS wants UTC as YYYYMMDDTHHMMSSZ. */
function toIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold long lines at 75 octets, per RFC 5545. */
function fold(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest) parts.push(' ' + rest);
  return parts.join('\r\n');
}

function esc(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\;')
    .replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * @param {object} opts
 * @param {Array}  opts.events  [{ start: Date, summary, description, uid }]
 * @param {number} opts.alarmMinutesBefore  0 = alarm exactly at leave time
 * @param {string} opts.calendarName
 */
export function buildIcs({ events, alarmMinutesBefore = 0, calendarName = 'StuyShuttle' }) {
  const now = toIcsUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PROD_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calendarName)}`,
    // Ask subscribers to re-poll roughly hourly.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  for (const ev of events) {
    const start = ev.start;
    const end = new Date(start.getTime() + 5 * 60_000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${toIcsUtc(start)}`,
      `DTEND:${toIcsUtc(end)}`,
      fold(`SUMMARY:${esc(ev.summary)}`),
      fold(`DESCRIPTION:${esc(ev.description || '')}`),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      fold(`DESCRIPTION:${esc(ev.summary)}`),
      `TRIGGER:-PT${Math.max(0, alarmMinutesBefore)}M`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Build leave-home events from a baked snapshot.
 *
 * Only emits events on days the route actually runs -- the whole point is that
 * this feed can be trusted without opening the app, so it must never place an
 * alarm for a bus that doesn't exist (Route C does not run Fridays).
 */
export function buildLeaveEvents({
  snapshot, routeId, stopId, walkToStop, buffer, rideMinutes, walkToBuilding,
  destinationName, weeks = 16, from = new Date(), onlyDepartures = null,
}) {
  const sched = snapshot.schedules?.[routeId];
  const stop = sched?.stops.find((s) => s.stopId === stopId);
  if (!stop?.times.length) return [];

  const serviceDays = snapshot.serviceDays?.[routeId];
  const runsOn = (d) =>
    !Array.isArray(serviceDays) || serviceDays.length !== 7 ? true : serviceDays[d.getDay()] === true;

  const events = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);

  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(day.getTime() + i * 86_400_000);
    if (!runsOn(d)) continue;

    // An alarm for every departure is an alarm you learn to ignore. Default to
    // the one you actually take; `onlyDepartures: null` emits them all.
    const wanted = onlyDepartures?.length
      ? stop.times.filter((t) => onlyDepartures.includes(t.trim()))
      : stop.times;

    for (const t of wanted) {
      const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim());
      if (!m) continue;
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      if (/pm/i.test(m[3]) && h !== 12) h += 12;
      if (/am/i.test(m[3]) && h === 12) h = 0;

      const departs = new Date(d);
      departs.setHours(h, min, 0, 0);
      const leave = new Date(departs.getTime() - (walkToStop + buffer) * 60_000);
      if (leave < from) continue;

      const arrive = new Date(departs.getTime() + (rideMinutes + walkToBuilding) * 60_000);
      const hhmm = (x) => x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      events.push({
        uid: `${routeId}-${stopId}-${departs.toISOString().slice(0, 16)}@stuyshuttle`,
        start: leave,
        summary: `Leave for the ${hhmm(departs)} shuttle`,
        description:
          `${sched.name} departs ${stop.name} at ${hhmm(departs)}. ` +
          `Arrive ${destinationName} around ${hhmm(arrive)}. ` +
          `Includes ${walkToStop} min walk + ${buffer} min buffer.`,
      });
    }
  }
  return events;
}
