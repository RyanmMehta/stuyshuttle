/** The alerts feed — the same information as Passio's own feed, but readable. */
import { h, icon, fmtLongDate, fmtTime } from '../ui.js';

export function renderAlerts(ctx) {
  const { alerts, prefs, pushState, actions } = ctx;
  const frag = document.createDocumentFragment();

  frag.append(renderEnableCta(pushState, actions));

  const relevant = alerts.filter((a) => a.relevant !== false);
  const other = alerts.filter((a) => a.relevant === false);

  if (!relevant.length) {
    frag.append(h('section', { class: 'card card--empty' },
      icon('bell', 26),
      h('div', { class: 'card__empty-title' }, 'No active alerts for your routes'),
      h('div', { class: 'muted' }, 'NYU posts here when service changes, is delayed, or is suspended. This screen refreshes automatically.')));
  } else {
    frag.append(h('div', { class: 'feed' }, relevant.map((a) => alertCard(a, prefs))));
  }

  if (other.length) {
    frag.append(h('details', { class: 'card card--details' },
      h('summary', { class: 'card__title' }, `Other NYU services (${other.length})`,
        h('span', { class: 'card__hint' }, ' · ferry, Brooklyn, commuter')),
      h('div', { class: 'feed feed--nested' }, other.map((a) => alertCard(a, prefs)))));
  }

  frag.append(h('div', { class: 'muted center small' }, 'Source: NYU Transportation via Passio GO'));
  return frag;
}

function renderEnableCta(pushState, actions) {
  if (pushState.status === 'on') {
    return h('div', { class: 'cta cta--on' }, icon('check', 16),
      h('span', null, 'Notifications on — new alerts arrive immediately.'),
      h('button', { class: 'linkbtn', onclick: actions.unsubscribePush }, 'Turn off'));
  }
  if (pushState.status === 'unconfigured') {
    return h('div', { class: 'cta cta--muted' }, icon('bell', 16),
      h('span', null, 'Push alerts aren’t set up yet — see Settings → Notifications.'));
  }
  if (pushState.status === 'needs-install') {
    return h('div', { class: 'cta cta--muted' }, icon('bell', 16),
      h('span', null, 'To get notifications on iPhone: Share → Add to Home Screen, then open the app from there.'));
  }
  if (pushState.status === 'unsupported') {
    return h('div', { class: 'cta cta--muted' }, icon('bell', 16),
      h('span', null, 'This browser can’t receive push notifications.'));
  }
  return h('button', { class: 'cta cta--action', onclick: actions.subscribePush, disabled: pushState.busy },
    icon('bell', 18),
    h('span', null, pushState.busy ? 'Enabling…' : 'Enable Notifications to receive messages immediately'),
    pushState.error ? h('span', { class: 'cta__err' }, pushState.error) : null);
}

function alertCard(a, prefs) {
  const at = a.at || a.createdAt;
  return h('article', { class: `alertcard ${a.important ? 'alertcard--important' : ''}` },
    h('div', { class: 'alertcard__when' },
      at ? `${fmtLongDate(at)} ${fmtTime(at)}` : 'Undated',
      a.important ? h('span', { class: 'tag tag--danger' }, 'Important') : null),
    h('div', { class: 'alertcard__title' }, a.title),
    a.body ? h('div', { class: 'alertcard__body' }, a.body) : null,
    a.to ? h('div', { class: 'alertcard__until' }, `Active until ${fmtLongDate(a.to)} ${fmtTime(a.to)}`) : null);
}
