# StuyShuttle push worker

Optional. The app is fully functional without it.

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

**3. Store the private key as a secret**, and set the public key:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
```

Also set `VAPID_SUBJECT` in `wrangler.toml` to your own `mailto:` address.

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

```bash
curl -X POST https://stuyshuttle-push.<you>.workers.dev/test
```

That pushes a test notification to every subscriber. Watch live logs with
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
