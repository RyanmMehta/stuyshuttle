/** Every route that touches Stuytown or Washington Square, with full timetables. */
import { h, icon, fmtTime } from '../ui.js';
import { ROUTES, serviceDayLabel, parseClockTime } from '../schedule.js';

export function renderRoutes(ctx) {
  const { snapshot, prefs, actions, ui, timetableStatus, now } = ctx;
  const selected = ROUTES[ui.routeTab] || ROUTES.C;
  const sched = snapshot.schedules?.[selected.id];
  const frag = document.createDocumentFragment();

  frag.append(h('div', { class: 'seg seg--3' }, Object.values(ROUTES).map((r) =>
    h('button', {
      class: `seg__btn ${selected.id === r.id ? 'is-active' : ''}`,
      style: selected.id === r.id ? { background: r.color } : null,
      onclick: () => actions.setRouteTab(r.key),
    }, h('span', { class: 'segdot', style: { background: r.color } }), r.name))));

  const days = serviceDayLabel(snapshot.serviceDays, selected.id);
  const timed = sched?.stops?.filter((s) => s.times.length) || [];
  const first = timed[0]?.times?.[0], last = timed[timed.length - 1]?.times?.slice(-1)[0];

  frag.append(h('section', { class: 'card' },
    h('div', { class: 'routehead' },
      h('span', { class: 'chip chip--lg', style: { background: selected.color } }, selected.key),
      h('div', null,
        h('div', { class: 'routehead__name' }, selected.name),
        h('div', { class: 'muted' },
          days ? `Runs ${days}` : 'Service days unknown',
          first && last ? ` · ${first} – ${last}` : ''))),
    routeNotes(selected.key)));

  if (!sched) {
    frag.append(h('section', { class: 'card card--empty' }, icon('route', 24),
      h('div', { class: 'card__empty-title' }, 'No published timetable'),
      h('div', { class: 'muted' }, 'NYU has not published times for this route right now.')));
  } else {
    const myStops = new Set([prefs.homeStopId, '6545']);
    frag.append(h('section', { class: 'card' },
      h('h2', { class: 'card__title' }, 'All stops',
        h('span', { class: 'card__hint' }, ' · times are scheduled departures')),
      h('div', { class: 'stops' }, sched.stops.map((s) => {
        const next = s.times.map((t) => parseClockTime(t, now)).find((ts) => ts && ts > now);
        return h('div', { class: `stop ${myStops.has(s.stopId) ? 'stop--mine' : ''}` },
          h('div', { class: 'stop__name' }, s.name,
            s.source === 'seed' ? h('span', { class: 'tag' }, 'verified backup') : null,
            s.source === 'previous' ? h('span', { class: 'tag' }, 'last known') : null),
          h('div', { class: 'stop__times' },
            s.times.length
              ? s.times.map((t) => h('span', { class: `t ${next && parseClockTime(t, now) === next ? 't--next' : ''}` }, t))
              : h('span', { class: 'muted' }, 'no published times')));
      }))));
  }

  frag.append(h('section', { class: 'card' },
    h('div', { class: 'between' },
      h('div', null,
        h('div', { class: 'label' }, 'Timetable data'),
        h('div', { class: 'muted small' },
          timetableStatus.lastRefreshAt
            ? `Checked against NYU ${fmtTime(timetableStatus.lastRefreshAt)} today`
            : `Baked ${(snapshot.generatedAt || '').slice(0, 10)} · not yet re-checked today`)),
      h('button', { class: 'btn btn--secondary', onclick: actions.refreshTimetable, disabled: timetableStatus.refreshing },
        icon('refresh', 15), timetableStatus.refreshing ? 'Checking…' : 'Check now')),
    timetableStatus.warnings?.length
      ? h('ul', { class: 'warnlist' }, timetableStatus.warnings.slice(0, 4).map((w) => h('li', null, w)))
      : null));

  return frag;
}

function routeNotes(key) {
  const notes = {
    C: ['Mornings only. Stay on to 715 Broadway — Third Ave/13th looks close on a map but is an 18-minute walk to Stern.',
        'Your stop, 20th St at Loop Exit, is the first stop: best chance of a seat.'],
    E: ['Your ride home. First Ave at 17th St is the drop-off for Stuytown.',
        'The only one of the three that runs on Fridays.'],
    F: ['Midday and afternoon service between 715 Broadway and Third Avenue.',
        'Gets you to Third Ave/13th — a 12-minute walk from north Stuytown.'],
  };
  return h('ul', { class: 'notes' }, (notes[key] || []).map((n) => h('li', null, n)));
}
