/**
 * Timetable — the organised view of every route that gets you to class or
 * home, from every stop around Stuytown, straight from NYU's official sheets.
 */
import { h, icon, fmtTime } from '../ui.js';
import { parseClockTime, nyParts } from '../schedule.js';
import { ROUTES, DAY_TYPE_LABEL, tableFor, columnIndex, stopName, CAMPUS_STOP } from '../routes.js';

const DAY_TYPES = ['monthu', 'fri', 'weekend'];

/** Which day type "today" is, for the default selection. */
function todayType(ts) {
  const dow = nyParts(ts).dow;
  return dow === 0 || dow === 6 ? 'weekend' : dow === 5 ? 'fri' : 'monthu';
}

/** Boards: which columns to show for each purpose. Order matters (ride direction). */
const BOARDS = {
  toCampus: [
    { route: 'C', title: 'Route C · to campus', cols: [['6556', 'board'], ['6559', 'board'], ['6561', 'board'], ['6562', 'board'], ['6563', 'board'], [CAMPUS_STOP, 'alight']] },
    { route: 'E', title: 'Route E · to campus (around the loop)', cols: [['6566', 'board'], ['13118', 'board'], ['6573', 'board'], [CAMPUS_STOP, 'alight']] },
    { route: 'W', title: 'Route W · to campus (weekends)', cols: [['6566', 'board'], ['13118', 'board'], ['6573', 'board'], [CAMPUS_STOP, 'alight']] },
  ],
  toHome: [
    { route: 'E', title: 'Route E · home', cols: [[CAMPUS_STOP, 'board'], ['6580', 'board'], ['6566', 'alight'], ['6567', 'alight']] },
    { route: 'W', title: 'Route W · home (weekends)', cols: [[CAMPUS_STOP, 'board'], ['6580', 'board'], ['6566', 'alight'], ['6567', 'alight']] },
  ],
};

export function renderTimetable(ctx) {
  const { official, now, prefs, walk, ui, actions } = ctx;
  const selected = ui.dayType || todayType(now);
  const frag = document.createDocumentFragment();

  // Day-type selector
  frag.append(h('div', { class: 'seg seg--3' }, DAY_TYPES.map((dt) =>
    h('button', { class: `seg__btn ${selected === dt ? 'is-active' : ''}`, onclick: () => actions.setDayType(dt) },
      DAY_TYPE_LABEL[dt], dt === todayType(now) ? h('span', { class: 'seg__today' }, 'today') : null))));

  const sample = sampleTsFor(selected, now);   // an instant on a day of that type
  const running = Object.values(ROUTES).filter((r) => r.official && tableFor(official, r.key, sample));

  for (const [dirKey, label, ic] of [['toCampus', 'To class', 'school'], ['toHome', 'Home', 'home']]) {
    frag.append(h('h2', { class: 'section-title' }, icon(ic, 16), label));
    let any = false;
    for (const board of BOARDS[dirKey]) {
      const table = tableFor(official, board.route, sample);
      if (!table) continue;
      any = true;
      frag.append(renderBoard({ board, table, route: ROUTES[board.route], now, sample, isToday: selected === todayType(now), prefs, walk, dirKey }));
    }
    if (!any) frag.append(h('section', { class: 'card card--empty' }, h('div', { class: 'muted' }, `No ${label.toLowerCase()} shuttle on ${DAY_TYPE_LABEL[selected]}.`)));
  }

  frag.append(h('p', { class: 'muted small' },
    'Times are NYU’s published schedule (Academic Year 2026–27, in effect 9/2/26). Live positions and delays show on the Trip tab.'));
  if (!running.length) frag.append(h('p', { class: 'muted small' }, 'No shuttle runs on this day type.'));
  return frag;
}

function sampleTsFor(dayType, now) {
  // Find the next date (today or later) whose day type matches, at the same wall-clock time.
  for (let i = 0; i < 8; i++) {
    const ts = now + i * 86_400_000;
    if (todayType(ts) === dayType) return ts;
  }
  return now;
}

function renderBoard({ board, table, route, now, sample, isToday, prefs, walk, dirKey }) {
  const cols = board.cols.map(([stopId, use]) => ({ stopId, use, idx: columnIndex(table, stopId, use) })).filter((c) => c.idx >= 0);
  const boardIdx = cols[0]?.idx ?? 0;

  // Rows: trips that serve the first column (or, for partial trips, any shown column).
  const rows = table.trips
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => cols.some((c) => t[c.idx]))
    .map(({ t, i }) => {
      const cells = cols.map((c) => t[c.idx] || null);
      const anchor = cells.find(Boolean);
      const ts = anchor ? parseClockTime(anchor, sample) : null;
      return { i, cells, ts };
    })
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const nextIdx = isToday ? rows.findIndex((r) => r.ts !== null && r.ts > now - 60_000) : -1;

  const head = h('tr', null,
    cols.map((c, k) => {
      const isHome = c.stopId === prefs.homeStopId;
      const walkMin = dirKey === 'toCampus' && c.use === 'board'
        ? (isHome ? prefs.walkToStop : walk?.homeToStop?.[c.stopId])
        : dirKey === 'toHome' && c.use === 'alight' ? (isHome ? prefs.walkToStop : walk?.homeToStop?.[c.stopId]) : null;
      return h('th', { class: `${k === 0 ? 'tt__sticky' : ''} ${isHome ? 'tt__home' : ''} ${c.use === 'alight' ? 'tt__alight' : ''}` },
        h('div', { class: 'tt__stop' }, stopName(c.stopId)),
        h('div', { class: 'tt__meta' }, c.use === 'alight' ? 'arrive' : 'depart', walkMin != null ? ` · ${walkMin} min walk` : ''));
    }));

  const body = rows.map((r, n) =>
    h('tr', { class: `${n === nextIdx ? 'tt__next' : ''} ${isToday && r.ts !== null && r.ts < now - 60_000 ? 'tt__past' : ''}` },
      r.cells.map((cell, k) => h('td', { class: k === 0 ? 'tt__sticky' : '' }, cell ? cell.replace(' ', ' ') : '—'))));

  return h('section', { class: 'card card--tt' },
    h('div', { class: 'tt__head' },
      h('span', { class: 'chip', style: { background: route.color } }, route.key),
      h('div', null,
        h('div', { class: 'tt__title' }, board.title),
        h('div', { class: 'muted small' }, `${rows.length} trips`))),
    h('div', { class: 'tt__scroll' },
      h('table', { class: 'tt' }, h('thead', null, head), h('tbody', null, body))),
    nextIdx >= 0
      ? h('div', { class: 'muted small' }, `Next: ${fmtTime(rows[nextIdx].ts)} from ${stopName(cols[0].stopId)}`)
      : null);
}
