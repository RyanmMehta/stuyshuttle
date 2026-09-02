/** Settings: your stop, your building, your walk, and the two safety nets. */
import { h, icon, fmtTime } from '../ui.js';
import { HOME_STOPS } from '../schedule.js';

export function renderSettings(ctx) {
  const { prefs, walk, snapshot, actions, pushState, derived, timetableStatus } = ctx;
  const frag = document.createDocumentFragment();

  // --- Trip -----------------------------------------------------------------
  frag.append(h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Your trip'),
    field('My stop', select(HOME_STOPS.map((s) => [s.id, `${s.name} (${s.route})`]), prefs.homeStopId, (v) => {
      const walkDefault = walk?.homeToStop?.[v];
      actions.savePrefs({ homeStopId: v, ...(walkDefault != null ? { walkToStop: walkDefault } : {}) });
    })),
    field('Destination', select(Object.entries(walk?.buildings || {}).map(([k, b]) => [k, b.name]), prefs.building,
      (v) => actions.savePrefs({ building: v }))),
    field('Walk to stop', stepper(prefs.walkToStop, 0, 30, 'min', (v) => actions.savePrefs({ walkToStop: v }))),
    field('Safety buffer', stepper(prefs.buffer, 0, 15, 'min', (v) => actions.savePrefs({ buffer: v }))),
    h('p', { class: 'muted small' }, 'These two numbers are what make the countdown accurate. Walk it once, then correct them.')));

  // --- Calendar alarms --------------------------------------------------------
  const times = derived.schedule?.stops?.find((s) => s.stopId === derived.stop.id)?.times || [];
  frag.append(h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Calendar alarms',
      h('span', { class: 'tag tag--ok' }, 'most reliable')),
    h('p', { class: 'muted small' },
      'A daily “leave now” alarm in your phone’s calendar. iOS fires these on time, offline, every time — more dependable than any notification.'),
    times.length
      ? field('Departure', select(times.map((t) => [t, t]), prefs.usualDeparture, (v) => actions.savePrefs({ usualDeparture: v })))
      : h('div', { class: 'muted small' }, 'No published times for your stop yet.'),
    h('button', { class: 'btn btn--primary btn--block', onclick: actions.downloadCalendar, disabled: !times.length },
      icon('calendar', 16), `Download alarms for the ${prefs.usualDeparture || ''} shuttle`),
    h('p', { class: 'muted small' }, 'Open the file and choose Add All. One alarm per service day for 16 weeks.')));

  // --- Notifications ----------------------------------------------------------
  frag.append(h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Notifications'),
    h('p', { class: 'muted small' },
      'Pushes NYU service alerts the moment they’re posted, plus a heads-up if your bus is running late or never starts tracking. On iPhone this only works after adding to the Home Screen, and Apple can delay delivery — keep the calendar alarms as your real backup.'),
    pushRow(pushState, actions),
    pushState.status === 'on' || pushState.status === 'off'
      ? field('Also notify for other NYU services', toggle(prefs.notifyOtherServices, (v) => actions.savePrefs({ notifyOtherServices: v })))
      : null));

  // --- Data -------------------------------------------------------------------
  frag.append(h('section', { class: 'card' },
    h('h2', { class: 'card__title' }, 'Data'),
    kv('Source', 'NYU Transportation via Passio GO (live)'),
    kv('Baked timetable', (snapshot.generatedAt || '').slice(0, 10) || '—'),
    kv('Last checked against NYU', timetableStatus.lastRefreshAt ? fmtTime(timetableStatus.lastRefreshAt) : 'not yet today'),
    snapshot.warnings?.length ? kv('Notes', snapshot.warnings.join(' · ')) : null,
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn btn--secondary', onclick: actions.refreshTimetable, disabled: timetableStatus.refreshing },
        icon('refresh', 15), timetableStatus.refreshing ? 'Checking…' : 'Re-check timetable'),
      h('button', { class: 'btn btn--secondary', onclick: actions.resetApp }, 'Reset app data'))));

  frag.append(h('p', { class: 'muted center small' }, 'StuyShuttle · not affiliated with NYU · times come from NYU’s live system'));
  return frag;
}

// --- widgets -----------------------------------------------------------------

function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), control);
}

function select(options, value, onchange) {
  const s = h('select', { class: 'input', onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  return s;
}

function stepper(value, min, max, unit, onchange) {
  const out = h('span', { class: 'stepper__val' }, `${value} ${unit}`);
  const set = (v) => { const n = Math.max(min, Math.min(max, v)); out.textContent = `${n} ${unit}`; onchange(n); };
  return h('div', { class: 'stepper' },
    h('button', { class: 'stepper__btn', onclick: () => set(value - 1), 'aria-label': 'decrease' }, '−'),
    out,
    h('button', { class: 'stepper__btn', onclick: () => set(value + 1), 'aria-label': 'increase' }, '+'));
}

function toggle(on, onchange) {
  return h('button', {
    class: `toggle ${on ? 'is-on' : ''}`, role: 'switch', 'aria-checked': on,
    onclick: () => onchange(!on),
  }, h('span', { class: 'toggle__knob' }));
}

function kv(k, v) {
  return h('div', { class: 'kv' }, h('span', { class: 'kv__k' }, k), h('span', { class: 'kv__v' }, v));
}

function pushRow(pushState, actions) {
  const map = {
    unconfigured: ['Not set up', 'Deploy the worker in worker/ and paste its URL into js/push.js.'],
    unsupported: ['Unavailable', 'This browser cannot receive push notifications.'],
    'needs-install': ['Add to Home Screen first', 'Share → Add to Home Screen, then open the app from there.'],
    off: ['Off', 'Tap to enable.'],
    on: ['On', 'You’ll be told about alerts, late buses, and buses that never start tracking.'],
  };
  const [title, detail] = map[pushState.status] || map.off;
  const actionable = pushState.status === 'off' || pushState.status === 'on';
  return h('div', { class: 'pushrow' },
    h('div', null, h('div', { class: 'label' }, `Push alerts: ${title}`), h('div', { class: 'muted small' }, pushState.error || detail)),
    actionable ? h('button', {
      class: `btn ${pushState.status === 'on' ? 'btn--secondary' : 'btn--primary'}`,
      onclick: pushState.status === 'on' ? actions.unsubscribePush : actions.subscribePush,
      disabled: pushState.busy,
    }, pushState.busy ? '…' : pushState.status === 'on' ? 'Turn off' : 'Enable') : null);
}
