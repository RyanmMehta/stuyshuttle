/**
 * StuyShuttle push worker (Cloudflare Workers free tier).
 *
 * Two jobs, both things a static timetable cannot do:
 *
 *   1. Relay NYU service alerts the moment they are posted — the same messages
 *      Passio's own feed shows ("Service Resumes", "detour", "ferry swap") —
 *      filtered to the routes you use unless you opt into all of them.
 *   2. During your morning window, warn when reality diverges from the
 *      timetable: the tracked bus is running late, or the departure is close
 *      and nothing is tracking at all.
 *
 * It stays silent otherwise. A notifier that cries wolf is one you stop
 * reading, and then it's worse than none.
 *
 * iOS caveat, stated plainly: Safari only delivers web push to a site added to
 * the Home Screen (iOS 16.4+), and Apple throttles background delivery. This
 * is a useful extra; the calendar feed is the alarm.
 *
 * Free-tier budget: cron every minute = 1,440 runs/day. KV free tier allows
 * 1,000 writes and 1,000 list operations per day, so we (a) keep subscribers
 * in ONE index key and read it (reads are 100k/day) instead of listing, and
 * (b) write only when something actually changes.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { htmlToText, isRelevantAlert } from '../../js/text.js';

const PASSIO = 'https://passiogo.com';
const SYSTEM_ID = '1007';
const DEVICE_ID = 'stuyshuttle-worker';
const INDEX_KEY = 'subs:index';
const SEEN_KEY = 'alerts:seen';

const LATE_THRESHOLD_MIN = 3;      // push when the bus is this late
const EXPECT_TRACKING_MIN = 12;    // within this many minutes of departure we expect a bus

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/vapid-public-key') return json({ key: env.VAPID_PUBLIC_KEY || null });

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.subscription?.endpoint) return json({ error: 'bad subscription' }, 400);
      const id = await hash(body.subscription.endpoint);
      await env.SUBS.put(`sub:${id}`, JSON.stringify({
        subscription: body.subscription, prefs: body.prefs || {}, updatedAt: Date.now(),
      }));
      await addToIndex(env, `sub:${id}`);
      return json({ ok: true, id });
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.endpoint) return json({ error: 'missing endpoint' }, 400);
      const key = `sub:${await hash(body.endpoint)}`;
      await env.SUBS.delete(key);
      await removeFromIndex(env, key);
      return json({ ok: true });
    }

    if (url.pathname === '/test' && request.method === 'POST') {
      const sent = await broadcast(env, {
        title: 'StuyShuttle', body: 'Test notification — delivery is working.', tag: 'test',
      });
      return json({ sent });
    }

    if (url.pathname === '/status') {
      const index = await readIndex(env);
      return json({ ok: true, subscribers: index.length, window: checkWindow() });
    }

    return json({ ok: true, service: 'stuyshuttle-push' });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Service window in New York local time (DST-safe). Alerts are relayed at any
 * hour; late/no-tracking checks only when a shuttle could be running.
 */
function checkWindow(now = new Date()) {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  return {
    ny,
    // Mon–Fri 06:45–11:15 covers Route C (Mon–Thu) and Route E's morning runs.
    morning: day >= 1 && day <= 5 && mins >= 6 * 60 + 45 && mins <= 11 * 60 + 15,
  };
}

async function runCheck(env) {
  const subs = await loadSubscribers(env);
  if (!subs.length) return;

  const { ny, morning } = checkWindow();

  // 1) New alerts, at any hour.
  await relayNewAlerts(env, subs);

  // 2) Divergence from the timetable, mornings only.
  if (!morning) return;
  for (const { key, record } of subs) {
    const p = record.prefs || {};
    if (!p.routeId || !p.stopId) continue;
    const note = await evaluateStop({
      routeId: String(p.routeId), stopId: String(p.stopId), position: p.position || '1',
      walk: Number(p.walkToStop ?? 4), buffer: Number(p.buffer ?? 3), ny,
    }).catch(() => null);
    if (!note) continue;

    const stateKey = `state:${key}`;
    if ((await env.SUBS.get(stateKey)) === note.dedupe) continue;
    await env.SUBS.put(stateKey, note.dedupe, { expirationTtl: 6 * 3600 });
    await sendOne(env, record.subscription, note.payload, key);
  }
}

async function relayNewAlerts(env, subs) {
  const alerts = await fetchAlerts().catch(() => null);
  if (!alerts) return;

  const seen = new Set(JSON.parse((await env.SUBS.get(SEEN_KEY)) || '[]'));
  const fresh = alerts.filter((a) => !seen.has(a.id));
  if (!fresh.length) return;

  for (const a of fresh) {
    for (const { key, record } of subs) {
      const wantsAll = record.prefs?.notifyOtherServices === true;
      if (!a.relevant && !wantsAll) continue;
      await sendOne(env, record.subscription, {
        title: a.title,
        body: a.body.length > 220 ? a.body.slice(0, 217) + '…' : a.body,
        tag: `alert-${a.id}`,
        url: './index.html#alerts',
      }, key);
    }
  }
  // One write, and keep the set bounded.
  const next = [...alerts.map((a) => a.id), ...seen].slice(0, 300);
  await env.SUBS.put(SEEN_KEY, JSON.stringify([...new Set(next)]));
}

/** Decide whether anything about the next departure is worth an interruption. */
async function evaluateStop({ routeId, stopId, position, walk, buffer, ny }) {
  const eta = await fetchEta(stopId, routeId, position);
  if (!eta || eta.outOfService) return null;

  const nowMin = ny.getHours() * 60 + ny.getMinutes();
  const scheduled = (eta.scheduleTimes || []).map(parseClock)
    .filter((m) => m !== null && m >= nowMin - 1).sort((a, b) => a - b)[0];
  if (scheduled === undefined) return null;

  const leaveIn = scheduled - walk - buffer - nowMin;
  if (leaveIn > EXPECT_TRACKING_MIN || leaveIn < -10) return null;

  if (eta.liveMinutes !== null) {
    const lateBy = Math.round(eta.liveMinutes - (scheduled - nowMin));
    if (lateBy >= LATE_THRESHOLD_MIN) {
      return {
        dedupe: `late:${scheduled}:${Math.floor(lateBy / 2)}`,
        payload: {
          title: `Shuttle running ${lateBy} min late`,
          body: `The ${fmt(scheduled)} is now about ${eta.liveMinutes} min out. Leave around ${fmt(nowMin + eta.liveMinutes - walk - buffer)}.`,
          tag: 'late',
        },
      };
    }
    return null; // on time — say nothing
  }

  if (leaveIn <= 6) {
    return {
      dedupe: `notracking:${scheduled}`,
      payload: {
        title: 'No bus tracking yet',
        body: `The ${fmt(scheduled)} shuttle isn't showing a live position. It may still come — leave a couple of minutes early.`,
        tag: 'notracking',
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Passio (mirrors js/api.js; see that file for the API's quirks)
// ---------------------------------------------------------------------------

async function fetchEta(stopId, routeId, position) {
  const url = `${PASSIO}/mapGetData.php?eta=3&deviceId=${DEVICE_ID}&stopIds=${stopId}&routeId=${routeId}&position=${position}&userId=${SYSTEM_ID}`;
  const raw = await (await fetch(url)).json();
  const etas = raw?.ETAs || {};
  const live = etas[stopId];
  let liveMinutes = null;
  if (Array.isArray(live)) {
    for (const e of live) {
      if (e.OOS) continue;
      if (Array.isArray(e.error) && /no valid gps|detour|yard/i.test(String(e.error[0]))) continue;
      const mins = e.arrivalTimestamp
        ? Math.round((e.arrivalTimestamp * 1000 - Date.now()) / 60000)
        : parseEtaText(e.eta);
      if (mins !== null && (liveMinutes === null || mins < liveMinutes)) liveMinutes = mins;
    }
  }
  const fallback = etas['0000']?.[0];
  return {
    liveMinutes,
    scheduleTimes: fallback?.scheduleTimes || live?.[0]?.scheduleTimes || [],
    outOfService: fallback?.outOfService === true,
  };
}

async function fetchAlerts() {
  const res = await fetch(`${PASSIO}/goServices.php?getAlertMessages=1&deviceId=${DEVICE_ID}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemSelected0: SYSTEM_ID, amount: 1, routesAmount: 0 }),
  });
  const raw = await res.json();
  const now = Date.now();
  return (raw.msgs || [])
    .map((m) => {
      const title = (m.name || '').trim();
      const body = htmlToText(m.html || m.gtfsAlertDescriptionText || '');
      return {
        id: String(m.id), title, body,
        to: m.to ? Date.parse(m.to.replace(' ', 'T') + '-04:00') : null,
        relevant: isRelevantAlert(`${title} ${body}`),
      };
    })
    .filter((a) => !a.to || a.to > now - 3600_000);
}

function parseEtaText(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  if (t === '--' || t.startsWith('no ') || t.startsWith('route ') || t.startsWith('service ')) return null;
  if (t.startsWith('arriv') || t === 'now' || t === 'due') return 0;
  const hm = /(\d+)\s*h(?:r|our)?s?\s*(\d+)\s*min/.exec(t);
  if (hm) return +hm[1] * 60 + +hm[2];
  const range = /(\d+)\s*[-–]\s*(\d+)\s*min/.exec(t); // "1-2 min" → earlier bound
  if (range) return Math.min(+range[1], +range[2]);
  const m = /(\d+)\s*min/.exec(t);
  return m ? +m[1] : null;
}

const parseClock = (s) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s).trim());
  if (!m) return null;
  let h = +m[1];
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + +m[2];
};

const fmt = (mins) => {
  const h24 = ((Math.floor(mins / 60) % 24) + 24) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(((mins % 60) + 60) % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};

// ---------------------------------------------------------------------------
// Subscribers + delivery
// ---------------------------------------------------------------------------

async function readIndex(env) {
  try { return JSON.parse((await env.SUBS.get(INDEX_KEY)) || '[]'); } catch { return []; }
}
async function addToIndex(env, key) {
  const idx = await readIndex(env);
  if (!idx.includes(key)) await env.SUBS.put(INDEX_KEY, JSON.stringify([...idx, key]));
}
async function removeFromIndex(env, key) {
  const idx = await readIndex(env);
  if (idx.includes(key)) await env.SUBS.put(INDEX_KEY, JSON.stringify(idx.filter((k) => k !== key)));
}

async function loadSubscribers(env) {
  const idx = await readIndex(env);
  const out = [];
  for (const key of idx) {
    const raw = await env.SUBS.get(key);
    if (raw) { try { out.push({ key, record: JSON.parse(raw) }); } catch { /* skip */ } }
  }
  return out;
}

async function sendOne(env, subscription, payload, kvKey) {
  try {
    const req = await buildPushPayload(
      // Pass the object, not a JSON string, or the SW's e.data.json() returns a string.
      { data: payload, options: { ttl: 900, urgency: 'high' } },
      subscription,
      { subject: env.VAPID_SUBJECT || 'mailto:noreply@example.com', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    );
    const res = await fetch(subscription.endpoint, req);
    if (res.status === 404 || res.status === 410) { // browser dropped the subscription
      await env.SUBS.delete(kvKey);
      await removeFromIndex(env, kvKey);
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function broadcast(env, payload) {
  let sent = 0;
  for (const { key, record } of await loadSubscribers(env)) {
    if (await sendOne(env, record.subscription, payload, key)) sent++;
  }
  return sent;
}

async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
