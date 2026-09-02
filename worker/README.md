# StuyShuttle push worker

Deployed for this copy of the app at
`https://stuyshuttle-push.rm6886.workers.dev` (Cloudflare account of the
repo owner; KV namespace `SUBS`). See the main README. The app is fully
functional without it — it's the notification channel, not the alarm.

This does **not** send "leave now" reminders — the calendar feed does that, and
does it more reliably than iOS will ever deliver a web push. This exists for the
one thing a static timetable cannot do: tell you when reality diverges from the
schedule.

It notifies you when:

- NYU posts a **service alert** — relayed the minute it appears, at any hour,
  filtered to your routes (Settings can widen this to ferry/Brooklyn/commuter),
- during the morning window, the tracked bus is running **3+ minutes late**,
- your departure is imminent and **no bus is tracking at all**.

Otherwise it stays quiet. A notifier that cries wolf is one you stop reading.

## Why the push encoding is hand-rolled

`src/webpush.js` implements RFC 8291 (`aes128gcm`) and RFC 8292
(`Authorization: vapid t=…, k=…`) directly on WebCrypto. Apple's push service —
i.e. every iPhone — accepts only those; the off-the-shelf library we started
with emitted the pre-standard `aesgcm` / `WebPush …` forms that Chrome tolerates
and Apple rejects. The implementation is checked against the RFC 8291
Appendix A test vector in `tools/test-worker.mjs`.

## Cost

Free. Cloudflare's free tier allows 100,000 requests/day and cron triggers; this
uses roughly 720 invocations per week.

## Setup

```bash
cd worker
npm install
npx wrangler login
```

**1. Create the KV namespace** and put the returned id into `wrangler.toml`
(replacing `REPLACE_WITH_YOUR_KV_ID`):

```bash
npx wrangler kv namespace create SUBS
```

**2. Generate your own VAPID keypair.** Do not reuse anyone else's:

```bash
node gen-vapid.mjs
```

**3. Store all three VAPID values as secrets** (the subject is a `mailto:`
contact address; keeping it a secret keeps your email out of the public repo):

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_SUBJECT
```

**4. Deploy:**

```bash
npx wrangler deploy
```

**5. Point the app at it.** In `../js/push.js`, fill in:

```js
export const PUSH_ENDPOINT = 'https://stuyshuttle-push.<you>.workers.dev';
export const VAPID_PUBLIC_KEY = '<the public key from step 2>';
```

**6. On your iPhone**, open the app *from the Home Screen* (push will not work
from a Safari tab), then Settings → Disruption alerts → Enable.

## Checking it works

`/test` and `/run-now` can push to every subscriber, so they require an admin
token (set once: `npx wrangler secret put ADMIN_TOKEN`; on this Mac the token
is kept in `~/.stuyshuttle/admin-token`):

```bash
curl -X POST https://stuyshuttle-push.rm6886.workers.dev/test \
  -H "Authorization: Bearer $(cat ~/.stuyshuttle/admin-token)"
```

`POST /run-now` (same token) runs one cron cycle immediately and returns a
trace — alerts fetched, alerts new, pushes sent — which is the quickest way to
see the relay working.

`GET /status` (public) shows subscriber count, how many alerts the cron has
seen, and `lastCron` — a heartbeat updated at most every 10 minutes. If
`lastCron` is stale, the cron trigger isn't firing. Watch live logs with
`npx wrangler tail`.

## Scheduling

The cron is `* * * * *` — every minute, so alerts are relayed promptly at any
hour. The late-bus / no-tracking checks are gated in code (`checkWindow()`) to
Mon–Fri 6:45–11:15 AM **New York local time**, DST-safe, so nothing fires when
no shuttle could be running.

Free-tier budget: ~1,440 runs/day. Subscribers are kept in one KV index key
(read, never listed) and state is written only when something changes, which
keeps well inside KV's 1,000 writes/day.

If you change your usual stop or route in the app, re-enable alerts so the
worker stores your updated preferences.
