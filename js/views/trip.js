/** The main screen: when to leave, from which stop, and whether a bus is real. */
import { h, icon, fmtTime } from '../ui.js';
import { fmtAge } from '../live.js';
import { SUBWAY_FALLBACK, LONG_WAIT_MIN } from '../schedule.js';
import { ROUTES, stopName } from '../routes.js';

export function renderTrip(ctx) {
  const { derived, direction, actions } = ctx;
  const frag = document.createDocumentFragment();
  frag.append(renderAlertBanner(ctx));
  frag.append(renderDirection(direction, actions));

  const { hero } = derived;
  if (hero.mode === 'none' || hero.mode === 'missed' || !hero.trip) {
    frag.append(renderEmpty(ctx));
    if (derived.rows.length) frag.append(renderRows(ctx));
    frag.append(renderSubway());
  } else {
    frag.append(renderHero(ctx));
    if (hero.leaveIn > LONG_WAIT_MIN) {
      frag.append(notice('Long wait', `The next shuttle isn't for ${hero.leaveIn} minutes. Subway options are below.`));
    }
    frag.append(renderRows(ctx));
    frag.append(renderRouteStrip(ctx));
    if (hero.leaveIn > LONG_WAIT_MIN) frag.append(renderSubway());
  }
  return frag;
}

function renderAlertBanner({ alerts, prefs, actions }) {
  const live = alerts.filter((a) => a.relevant !== false && !prefs.dismissedAlerts.includes(a.id));
  if (!live.length) return document.createDocumentFragment();
  const a = live[0];
  return h('button', { class: `banner ${a.important ? 'banner--important' : ''}`, onclick: () => actions.setTab('alerts') },
    icon('alert', 18),
    h('div', { class: 'banner__text' }, h('div', { class: 'banner__title' }, a.title),
      h('div', { class: 'banner__meta' }, live.length > 1 ? `+${live.length - 1} more · tap to read` : 'Tap to read')),
    icon('chevron', 16));
}

function renderDirection(direction, actions) {
  const btn = (key, label, ic) => h('button', { class: `seg__btn ${direction === key ? 'is-active' : ''}`, onclick: () => actions.setDirection(key), 'aria-pressed': direction === key }, icon(ic, 16), label);
  return h('div', { class: 'seg' }, btn('toCampus', 'To class', 'school'), btn('toHome', 'Home', 'home'));
}

function badge(trip, freshness, offline) {
  const tier = offline ? 'offline' : trip?.live ? 'live' : trip ? 'scheduled' : 'none';
  const label = { live: 'Live', scheduled: 'Scheduled', offline: 'Offline timetable', none: 'No service' }[tier];
  const age = freshness?.lastSuccessAt ? fmtAge(Date.now() - freshness.lastSuccessAt) : null;
  return h('div', { class: `badge badge--${tier}` }, h('span', { class: 'badge__dot' }), h('span', null, label),
    age && tier !== 'offline' ? h('span', { class: 'badge__age' }, `· ${age}`) : null,
    freshness?.inFlight ? h('span', { class: 'badge__spin' }) : null);
}

const chip = (key, cls = 'chip') => h('span', { class: cls, style: { background: ROUTES[key]?.color || '#888' } }, key);

function renderHero(ctx) {
  const { derived, freshness, offline, prefs } = ctx;
  const { hero, destName } = derived;
  const t = hero.trip;
  const kicker = hero.mode === 'now' || hero.leaveIn <= 0 ? 'Leave now' : `Leave in ${hero.leaveIn} min`;

  const busLine = t.live
    ? h('div', { class: `busline ${t.late > 2 ? 'busline--late' : t.late < -1 ? 'busline--early' : 'busline--ok'}` }, icon('bus', 16),
        h('span', null, `Bus ${t.vehicle || ''}`.trim(),
          t.stopsAway !== null && t.stopsAway !== undefined ? ` · ${t.stopsAway === 0 ? 'at the stop' : `${t.stopsAway} stop${t.stopsAway === 1 ? '' : 's'} away`}` : '',
          t.late === null || t.late === undefined ? '' : t.late > 2 ? ` · ${t.late} min late` : t.late < -1 ? ` · ${-t.late} min early` : ' · on time',
          t.loadPct !== null && t.loadPct !== undefined ? ` · ${t.loadPct}% full` : ''))
    : h('div', { class: 'busline busline--none' }, icon('clock', 16), h('span', null, offline ? 'Timetable (offline)' : 'Not tracking yet — timetable time'));

  return h('section', { class: `hero hero--${hero.mode}` },
    h('div', { class: 'hero__top' }, badge(t, freshness, offline), h('span', { class: 'hero__stopname' }, t.stopLabel)),
    h('div', { class: 'hero__kicker' }, kicker),
    h('div', { class: `hero__time ${hero.mode === 'now' ? 'hero__time--urgent' : ''}` }, hero.mode === 'now' ? 'Now' : fmtTime(t.leaveAt)),
    h('div', { class: 'hero__line' }, chip(t.route), h('span', null, `${fmtTime(t.departsAt)} from ${t.stopLabel}`)),
    busLine,
    h('div', { class: 'hero__arrive' }, icon('arrow', 15), h('span', null, `Arrive ${destName} ${fmtTime(t.arriveAt)}`),
      t.route !== 'C' && ctx.direction === 'toCampus' ? h('span', { class: 'est' }, ` ${t.rideMin} min ride`) : null),
    h('div', { class: 'hero__foot' },
      hero.mode === 'now'
        ? (t.bufferLeftMinutes > 0 ? `${t.bufferLeftMinutes} min of your ${prefs.buffer} min buffer left — walking now still makes it` : 'Buffer gone — you need to be walking')
        : `${t.walkToStop} min walk + ${prefs.buffer} min buffer`));
}

function renderRows({ derived, prefs }) {
  const heroTrip = derived.hero.trip;
  const rows = derived.rows.map((t) => {
    const isHero = heroTrip && t.route === heroTrip.route && t.tripIndex === heroTrip.tripIndex && t.alightId === heroTrip.alightId;
    const status = t.missed ? 'missed' : t.tight ? 'now' : isHero ? 'primary' : '';
    const alt = (t.alternatives || []).slice(0, 2).map((a) => `${stopName(a.stopId)} ${fmtTime(a.departsAt)} · leave ${fmtTime(a.leaveAt)}`).join('  ·  ');
    return h('div', { class: `row row--${status}` },
      h('div', { class: 'row__time' }, chip(t.route, 'chip chip--sm row__chip'), t.live ? h('span', { class: 'dot dot--live' }) : null, fmtTime(t.departsAt)),
      h('div', { class: 'row__mid' },
        h('div', { class: 'row__main' }, t.missed ? `Too late · ${t.stopLabel}` : t.tight ? `Leave now · ${t.stopLabel}` : `Leave ${fmtTime(t.leaveAt)} · ${t.stopLabel}`),
        h('div', { class: 'row__sub' }, `Arrive ${fmtTime(t.arriveAt)} · ${t.walkToStop} min walk · ${t.rideMin} min ride`, t.live && t.vehicle ? ` · bus ${t.vehicle}` : '', t.late > 2 ? ` · ${t.late} min late` : ''),
        alt ? h('div', { class: 'row__alt' }, `or ${alt}`) : null),
      h('div', { class: 'row__right' }, t.missed ? icon('x', 16) : t.tight ? icon('walk', 18) : null));
  });
  return h('section', { class: 'card' }, h('h2', { class: 'card__title' }, 'Next buses', h('span', { class: 'card__hint' }, ' · every stop around Stuytown')), h('div', { class: 'rows' }, rows));
}

/** Where the bus is on the segment you ride. */
function renderRouteStrip(ctx) {
  const { derived, vehicles, snapshot, routeIdOf } = ctx;
  const t = derived.hero.trip; if (!t) return document.createDocumentFragment();
  const route = ROUTES[t.route];
  const routeId = routeIdOf(t.route);
  const seq = snapshot.sequences?.[routeId] || [];
  const iBoard = seq.findIndex((x) => x.stopId === t.stopId);
  let iOff = -1;
  for (let i = iBoard + 1; i < seq.length; i++) if (seq[i].stopId === t.alightId) { iOff = i; break; }
  if (iBoard < 0 || iOff < 0) return document.createDocumentFragment();
  const segment = seq.slice(Math.max(0, iBoard - 1), iOff + 1);

  const onRoute = vehicles.filter((v) => v.routeName === route.name && !v.outOfService && !v.outdated);
  const busAt = new Map();
  for (const v of onRoute) {
    let best = null, bestD = Infinity;
    seq.forEach((x, idx) => { const s = snapshot.stops?.[x.stopId]; if (!s) return; const d = haversine(v.lat, v.lon, s.lat, s.lon); if (d < bestD) { bestD = d; best = idx; } });
    if (best !== null && bestD < 600) busAt.set(best, v);
  }
  const items = segment.map((x, k) => {
    const idx = Math.max(0, iBoard - 1) + k;
    const isBoard = idx === iBoard, isOff = idx === iOff, v = busAt.get(idx);
    return h('div', { class: `strip__stop ${isBoard ? 'is-board' : ''} ${isOff ? 'is-off' : ''} ${idx < iBoard ? 'is-before' : ''}` },
      h('div', { class: 'strip__rail' }, h('span', { class: 'strip__dot' })),
      h('div', { class: 'strip__body' },
        h('div', { class: 'strip__name' }, stopName(x.stopId), isBoard ? h('span', { class: 'tag tag--accent' }, 'Board') : null, isOff ? h('span', { class: 'tag tag--ok' }, 'Get off') : null),
        v ? h('div', { class: 'strip__bus' }, icon('bus', 14), `Bus ${v.name} is here`, Number.isFinite(v.load) && v.capacity ? ` · ${v.load}/${v.capacity} aboard` : '') : null));
  });
  return h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, `${route.name} · your ride`, h('span', { class: 'card__hint' }, onRoute.length ? ` · ${onRoute.length} bus${onRoute.length === 1 ? '' : 'es'} tracking` : ' · no bus tracking')),
    h('div', { class: 'strip' }, items));
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLon = toR(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function renderEmpty(ctx) {
  const { derived, freshness, offline, now } = ctx;
  const { hero, emptyWhy } = derived;
  if (hero.mode === 'missed' && hero.trip) {
    const t = hero.trip, mins = Math.max(0, Math.floor((t.departsAt - now) / 60000));
    return h('section', { class: 'hero hero--empty hero--missed' },
      h('div', { class: 'hero__top' }, badge(t, freshness, offline), h('span', { class: 'hero__stopname' }, t.stopLabel)),
      h('div', { class: 'hero__kicker' }, 'Too late to walk it'),
      h('div', { class: 'hero__empty-title' }, `${fmtTime(t.departsAt)} ${t.route} — ${mins <= 0 ? 'leaving now' : `${mins} min away`}`),
      h('div', { class: 'hero__arrive' }, `${t.live && t.vehicle ? `Bus ${t.vehicle}` : 'The shuttle'} reaches ${t.stopLabel} at ${fmtTime(t.departsAt)}; your walk is ${t.walkToStop} min. ${mins > 0 ? 'Only makeable if you run. ' : ''}No later bus from any stop today.`));
  }
  return h('section', { class: 'hero hero--empty' },
    h('div', { class: 'hero__top' }, badge(null, freshness, offline)),
    h('div', { class: 'hero__kicker' }, 'No shuttle'),
    h('div', { class: 'hero__empty-title' }, emptyWhy?.title || 'No departures to show'),
    emptyWhy?.detail ? h('div', { class: 'hero__arrive' }, emptyWhy.detail) : null);
}

function renderSubway() {
  return h('section', { class: 'card' }, h('h2', { class: 'card__title' }, 'Get there another way'),
    h('div', { class: 'rows' }, SUBWAY_FALLBACK.map((s) => h('div', { class: 'row' },
      h('div', { class: 'row__time row__time--sm' }, icon('subway', 16), s.label),
      h('div', { class: 'row__mid' }, h('div', { class: 'row__main' }, s.detail), h('div', { class: 'row__sub' }, `${s.walkTo} min walk to the station`))))));
}

function notice(title, detail) {
  return h('section', { class: 'notice' }, icon('clock', 18), h('div', null, h('div', { class: 'notice__title' }, title), detail ? h('div', { class: 'notice__body' }, detail) : null));
}
