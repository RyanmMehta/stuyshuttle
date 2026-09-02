/** The main screen: when to leave, when you arrive, and whether a bus is real. */
import { h, el, icon, fmtTime } from '../ui.js';
import { fmtAge } from '../live.js';
import { explainNoService, SUBWAY_FALLBACK, LONG_WAIT_MIN } from '../schedule.js';

export function renderTrip(ctx) {
  const { derived, direction, actions } = ctx;
  const frag = document.createDocumentFragment();

  frag.append(renderAlertBanner(ctx));
  frag.append(renderDirection(direction, actions));

  if (derived.hero.mode === 'none' || !derived.trips.length) {
    frag.append(renderEmpty(ctx));
    frag.append(renderSubway());
  } else {
    frag.append(renderHero(ctx));
    if (derived.hero.leaveIn > LONG_WAIT_MIN) {
      const why = explainNoService(new Date(ctx.now), direction, {
        serviceDays: ctx.snapshot.serviceDays, routeId: derived.route.id,
      });
      frag.append(notice(why?.title || 'Long wait', why?.detail ||
        `The next shuttle isn't for ${derived.hero.leaveIn} minutes.`));
    }
    frag.append(renderDepartures(ctx));
    frag.append(renderRouteStrip(ctx));
    if (derived.hero.leaveIn > LONG_WAIT_MIN) frag.append(renderSubway());
  }
  return frag;
}

// ---------------------------------------------------------------------------

function renderAlertBanner({ alerts, prefs, actions }) {
  const live = alerts.filter((a) => a.relevant !== false && !prefs.dismissedAlerts.includes(a.id));
  if (!live.length) return document.createDocumentFragment();
  const a = live[0];
  return h('button', { class: `banner ${a.important ? 'banner--important' : ''}`, onclick: () => actions.setTab('alerts') },
    icon('alert', 18),
    h('div', { class: 'banner__text' },
      h('div', { class: 'banner__title' }, a.title),
      h('div', { class: 'banner__meta' }, live.length > 1 ? `+${live.length - 1} more · tap to read` : 'Tap to read')),
    icon('chevron', 16));
}

function renderDirection(direction, actions) {
  const btn = (key, label, ic) =>
    h('button', {
      class: `seg__btn ${direction === key ? 'is-active' : ''}`,
      onclick: () => actions.setDirection(key),
      'aria-pressed': direction === key,
    }, icon(ic, 16), label);
  return h('div', { class: 'seg' },
    btn('toCampus', 'To campus', 'school'),
    btn('toHome', 'To Stuytown', 'home'));
}

function badge(result, freshness, offline) {
  const tier = offline ? 'offline' : result.tier;
  const label = { live: 'Live', scheduled: 'Scheduled', offline: 'Offline timetable', none: 'No service' }[tier] || tier;
  const age = freshness?.lastSuccessAt ? fmtAge(Date.now() - freshness.lastSuccessAt) : null;
  return h('div', { class: `badge badge--${tier}` },
    h('span', { class: 'badge__dot' }),
    h('span', null, label),
    age && tier !== 'offline' ? h('span', { class: 'badge__age' }, `· ${age}`) : null,
    freshness?.inFlight ? h('span', { class: 'badge__spin' }) : null);
}

function renderHero(ctx) {
  const { derived, freshness, offline, prefs } = ctx;
  // Note: derived.walkToStop is direction-aware (home→stop, or building→715 Broadway).
  const { hero, route, stop, result, destName } = derived;
  const t = hero.trip;

  const kicker = hero.mode === 'now' || hero.leaveIn <= 0 ? 'Leave now' : `Leave in ${hero.leaveIn} min`;

  const busLine = t.live
    ? h('div', { class: `busline ${t.late > 2 ? 'busline--late' : t.late < -1 ? 'busline--early' : 'busline--ok'}` },
        icon('bus', 16),
        h('span', null,
          `Bus ${t.vehicle || ''}`.trim(),
          t.stopsAway !== null ? ` · ${t.stopsAway === 0 ? 'at the stop' : `${t.stopsAway} stop${t.stopsAway === 1 ? '' : 's'} away`}` : '',
          t.late === null ? '' : t.late > 2 ? ` · ${t.late} min late` : t.late < -1 ? ` · ${-t.late} min early` : ' · on time'))
    : h('div', { class: 'busline busline--none' },
        icon('clock', 16),
        h('span', null, result.tier === 'offline' ? 'Timetable (offline)' : 'Not tracking yet — timetable time'));

  return h('section', { class: `hero hero--${hero.mode}` },
    h('div', { class: 'hero__top' }, badge(result, freshness, offline),
      h('span', { class: 'hero__stopname' }, stop.name)),
    h('div', { class: 'hero__kicker' }, kicker),
    h('div', { class: `hero__time ${hero.mode === 'now' ? 'hero__time--urgent' : ''}` },
      hero.mode === 'now' ? 'Now' : fmtTime(t.leaveAt)),
    h('div', { class: 'hero__line' },
      h('span', { class: 'chip', style: { background: route.color } }, route.key),
      h('span', null, `${fmtTime(t.departsAt)} from ${stop.name}`)),
    busLine,
    h('div', { class: 'hero__arrive' },
      icon('arrow', 15),
      h('span', null, `Arrive ${destName} ${fmtTime(t.arriveAt)}`),
      t.arrivalEstimated ? h('span', { class: 'est', title: 'Passio publishes no time for this stop; estimated' }, 'est.') : null),
    h('div', { class: 'hero__foot' },
      hero.mode === 'now'
        ? (t.bufferLeftMinutes > 0
            ? `${t.bufferLeftMinutes} min of your ${prefs.buffer} min buffer left — walking now still makes it`
            : 'Buffer gone — you need to be walking')
        : `${derived.walkToStop} min walk + ${prefs.buffer} min buffer`));
}

function renderDepartures({ derived }) {
  const rows = derived.trips.slice(0, 5).map((t) => {
    const status = t.missed ? 'missed' : t.tight ? 'now' : t === derived.hero.trip ? 'primary' : '';
    return h('div', { class: `row row--${status}` },
      h('div', { class: 'row__time' },
        t.live ? h('span', { class: 'dot dot--live', title: 'Live' }) : null,
        fmtTime(t.departsAt)),
      h('div', { class: 'row__mid' },
        h('div', { class: 'row__main' },
          t.missed ? 'Too late' : t.tight ? 'Leave now' : `Leave ${fmtTime(t.leaveAt)}`),
        h('div', { class: 'row__sub' },
          `Arrive ${fmtTime(t.arriveAt)}`,
          t.live && t.vehicle ? ` · bus ${t.vehicle}` : '',
          t.late > 2 ? ` · ${t.late} min late` : '')),
      h('div', { class: 'row__right' },
        t.missed ? icon('x', 16) : t.tight ? icon('walk', 18) : null));
  });
  return h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Next departures'),
    h('div', { class: 'rows' }, rows));
}

/** Where the bus is, relative to your stop and where you get off. */
function renderRouteStrip(ctx) {
  const { derived, vehicles, snapshot } = ctx;
  const { route, stop, dropoff, schedule } = derived;
  if (!schedule) return document.createDocumentFragment();

  const seq = (snapshot.sequences?.[route.id] || []).filter((x, i, arr) => arr.findIndex((y) => y.stopId === x.stopId) === i);
  const stopsById = Object.fromEntries(schedule.stops.map((s) => [s.stopId, s]));
  const iBoard = seq.findIndex((x) => x.stopId === stop.id);
  const iOff = seq.findIndex((x) => x.stopId === dropoff);
  if (iBoard < 0) return document.createDocumentFragment();

  // Show the segment you ride, plus one stop of context before boarding.
  const from = Math.max(0, iBoard - 1);
  const to = iOff >= iBoard ? iOff : seq.length - 1;
  const segment = seq.slice(from, to + 1);

  // Live bus position: nearest stop on this route to any vehicle on it.
  const onRoute = vehicles.filter((v) => v.routeId === route.id && !v.outOfService && !v.outdated);
  const busAt = new Map();
  for (const v of onRoute) {
    let best = null, bestD = Infinity;
    seq.forEach((x, idx) => {
      const s = snapshot.stops?.[x.stopId];
      if (!s) return;
      const d = haversine(v.lat, v.lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = idx; }
    });
    if (best !== null && bestD < 600) busAt.set(best, v);
  }

  const items = segment.map((x, k) => {
    const idx = from + k;
    const s = stopsById[x.stopId];
    const isBoard = idx === iBoard, isOff = idx === iOff;
    const v = busAt.get(idx);
    const nextTime = s?.times?.map((t) => t).find(() => true); // first published time, shown as reference
    return h('div', { class: `strip__stop ${isBoard ? 'is-board' : ''} ${isOff ? 'is-off' : ''} ${idx < iBoard ? 'is-before' : ''}` },
      h('div', { class: 'strip__rail' }, h('span', { class: 'strip__dot' })),
      h('div', { class: 'strip__body' },
        h('div', { class: 'strip__name' },
          s?.name || x.stopId,
          isBoard ? h('span', { class: 'tag tag--accent' }, 'Board') : null,
          isOff ? h('span', { class: 'tag tag--ok' }, 'Get off') : null),
        v ? h('div', { class: 'strip__bus' }, icon('bus', 14), `Bus ${v.name} is here`,
              Number.isFinite(v.load) && v.capacity ? ` · ${v.load}/${v.capacity} aboard` : '') : null,
        !v && nextTime && !s.times.length ? null : null));
  });

  return h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, `${route.name} · your ride`,
      onRoute.length ? h('span', { class: 'card__hint' }, ` · ${onRoute.length} bus${onRoute.length === 1 ? '' : 'es'} tracking`) : h('span', { class: 'card__hint' }, ' · no bus tracking')),
    h('div', { class: 'strip' }, items));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function renderEmpty(ctx) {
  const { derived, direction, now, snapshot, eta } = ctx;
  const why = explainNoService(new Date(now), direction, {
    serviceDays: snapshot.serviceDays, routeId: derived.route.id, outOfService: eta?.outOfService === true,
  });
  return h('section', { class: 'hero hero--empty' },
    h('div', { class: 'hero__top' }, badge(derived.result, ctx.freshness, ctx.offline),
      h('span', { class: 'hero__stopname' }, derived.stop.name)),
    h('div', { class: 'hero__kicker' }, 'No shuttle'),
    h('div', { class: 'hero__empty-title' }, why?.title || derived.result.reason || 'Nothing scheduled'),
    why?.detail ? h('div', { class: 'hero__arrive' }, why.detail) : null);
}

function renderSubway() {
  return h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Get there another way'),
    h('div', { class: 'rows' }, SUBWAY_FALLBACK.map((s) =>
      h('div', { class: 'row' },
        h('div', { class: 'row__time row__time--sm' }, icon('subway', 16), s.label),
        h('div', { class: 'row__mid' },
          h('div', { class: 'row__main' }, s.detail),
          h('div', { class: 'row__sub' }, `${s.walkTo} min walk to the station`))))));
}

function notice(title, detail) {
  return h('section', { class: 'notice' },
    icon('clock', 18),
    h('div', null, h('div', { class: 'notice__title' }, title), detail ? h('div', { class: 'notice__body' }, detail) : null));
}
