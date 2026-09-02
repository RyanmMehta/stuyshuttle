# StuyShuttle

NYU shuttles from Stuytown to campus, on your phone's home screen.

Answers one question well: **when do I leave, and when do I get there?** —
live, with the honesty to say "no bus is tracking" or "no service today"
instead of showing a number it can't stand behind.

No backend, no accounts, no cost. A static page that calls NYU's own shuttle
system directly, plus an optional free worker for push notifications.

**Live:** <https://ryanmmehta.github.io/stuyshuttle/> — open it in Safari on
your iPhone, then Share → **Add to Home Screen**.

**Calendar alarms feed:** `https://ryanmmehta.github.io/stuyshuttle/leave-times.ics`
(Calendar → Add Subscription Calendar; updates itself whenever this repo is pushed).

---

## What I learned about the actual service

These came out of probing the live API and are not written down on NYU's site.

**Route C — the Stuytown route — runs mornings only, Monday to Thursday.**
Six trips, and **nothing on Fridays.** Departures from your stop:

| Stop | Times |
|---|---|
| 20th St at Loop Exit | 7:30, 8:00, 8:30, 9:10, 9:50, 10:30 |
| Avenue C at 18th St | 7:32, 8:02, 8:32, 9:12, 9:52, 10:32 |
| Avenue C at 16th St | 7:33, 8:03, 8:33, 9:13, 9:53, 10:33 |
| Avenue C at 14th St | 7:34, 8:04, 8:34, 9:14, 9:54, 10:34 |
| 14th St at Avenue B | 7:35, 8:05, 8:35, 9:15, 9:55, 10:35 |
| 14th St at Avenue A | 7:37, 8:07, 8:37, 9:17, 9:57, 10:37 |
| 14th St at 1st Avenue | 7:40, 8:10, 8:40, 9:20, 10:00, 10:40 |
| Third Ave at 13th St | 7:43, 8:13, 8:43, 9:23, 10:03, 10:43 |
| 715 Broadway | *no published time — estimated ~4 min later* |

**Stay on to 715 Broadway** (~7 min walk to KMC). Third Ave/13th looks closer on
a map but is ~18 minutes on foot. The app says so.

**Route E** (First Ave at 17th, Stuytown's west edge) is your ride home and the
only one of the three that runs **Fridays**. From 715 Broadway roughly 8:05–11:10
AM and 4:50–8:15 PM.

**Route F** covers midday/afternoon, Mon–Thu, 10:50 AM–9:10 PM.

**Service gap toward Stuytown ~11:45 AM – 4:36 PM.** The app says so and offers
the subway instead of an empty screen. Nothing runs on weekends.

---

## Running it locally

```bash
node tools/serve.mjs
```

Picks a free port automatically (starts at 8777) and prints the URL, so it
can't fail with "Address already in use". No build step.

Tests and data refresh:

```bash
node tools/test.mjs && node tools/test-worker.mjs
node tools/bake.mjs && node tools/ics.mjs
```

---

## Putting it on your iPhone

1. Publish the folder (below) so it has an `https://` address.
2. Open it in **Safari** (not Chrome).
3. Share → **Add to Home Screen**.
4. Launch from the icon. Full screen, works offline, notifications possible.

### Publishing

This copy is published from the `main` branch of
[RyanmMehta/stuyshuttle](https://github.com/RyanmMehta/stuyshuttle) via GitHub
Pages. Any `git push` redeploys in about a minute. An installed copy runs the
previous version on its *first* open after a deploy (while the service worker
fetches the new files in the background) and the new one from the next open —
so a fix lands on the second launch, never mid-session. Bump `VERSION` in
`sw.js` whenever app files change.

```bash
git add -A && git commit -m "update" && git push
```

---

## The four screens

- **Trip** — one big number: when to leave. Below it, whether a real bus is
  tracking (and how many stops away / how late), when you arrive, the next
  departures, and a strip showing where the bus is on your segment.
- **Alerts** — NYU's service alerts as a readable feed (the same feed Passio
  shows, with the ferry/Brooklyn noise collapsed), plus the button to turn on
  notifications.
- **Routes** — every route that touches Stuytown or Washington Square, every
  stop, every time, and which days it runs.
- **Settings** — your stop, building, walk time, safety buffer, calendar
  alarms, notifications, and a "re-check timetable against NYU" button.

The pill at the top right always says what you're looking at: **Live · 8s ago**,
**Reconnecting…**, **No live data**, or **Offline**. Tap it to refresh.

---

## How it stays accurate

Every number comes from the best source available, and the screen always
labels which:

| Badge | Meaning |
|---|---|
| **Live** | A real bus is being tracked by GPS right now. |
| **Scheduled** | No bus tracking yet; this is today's published timetable. |
| **Offline timetable** | No network; served from the cached snapshot. |
| **No service** | Genuinely nothing running — with the reason stated. |

Guards that exist specifically so you don't miss a bus:

- **Polls every 7 seconds** while open — the same cadence as Passio's own app —
  and immediately when you reopen the app or the network returns. A tick that
  hangs is abandoned and the next one still runs; the loop cannot die.
- **Countdowns round down.** 4 min 59 s shows as "4 min".
- **Default 3-minute buffer.** When you're inside it, the screen says *Now* and
  tells you how much buffer is left, rather than pretending it's fine.
- **Stale GPS is demoted.** A position older than 90 s stops counting as live.
- **Low-confidence estimates are dropped.** Passio flags its own bad data
  ("No valid GPS from the bus"); the app believes the flag.
- **Service days are enforced, per route.** On a Saturday the API returns
  `outOfService: true` *while still returning a full list of times*. The day
  check comes first. Route C on a Friday shows "No service on Fridays", not a
  timetable.
- **NYU's own "out of service today" wins** over the baked timetable.
- **A bus you can no longer walk to is named, not hidden.** Seen live on the
  first morning: bus 2119 due at 10:29:39, a 4-minute walk 8 seconds short, no
  later Route C — the screen says *Too late to walk it — 10:30 C, 2 min away,
  only makeable if you run*, and still lists the bus. Never "nothing scheduled"
  while a real bus is on the way.
- **"Starts at" / "finished for today" come from the day's timetable**, not
  hardcoded hours, so they stay right when NYU changes the schedule.
- **The timetable re-checks itself** against NYU once a day (and on demand),
  so semester changes appear without a redeploy. If the live answer for a stop
  is empty — which happens — the previous times are kept, then a verified seed,
  and the Routes tab says which.
- **All times are New York time**, regardless of the phone's zone.
- **A crash can't blank the screen.** Any rendering error drops to a plain
  timetable view with a "try again" button.

### Never missing it

**Calendar alarms (recommended).** Settings → Calendar alarms → pick your usual
departure → Download. Open the file, Add All. One native alarm per service day
for 16 weeks; iOS fires these on time, offline, every time. There's also a
subscribable `leave-times.ics` (Calendar → Add Subscription Calendar) that
updates itself when you re-bake and push.

**Notifications — on.** The worker in [`worker/`](worker/) is deployed to
Cloudflare (free tier). It relays NYU alerts the minute they're posted and, on
weekday mornings, warns if your bus is running 3+ minutes late or never starts
tracking. To receive them on iPhone: add the app to your Home Screen, open it
*from there*, then Alerts → **Enable Notifications**. Apple can delay
background delivery, so this is the disruption channel; the calendar is the
alarm. Details: [`worker/README.md`](worker/README.md).

### Tuning

Two numbers matter most, both in Settings: **walk to stop** (default 4 min) and
**safety buffer** (default 3 min). Walk it once, then correct them. Stop-to-
building walk times live in [`data/walk.json`](data/walk.json).

---

## Layout

```
index.html               shell
css/app.css              design system
js/app.js                controller: boot, polling, tabs, safe mode
js/views/{trip,alerts,routes,settings}.js
js/api.js                Passio endpoints + response normalization
js/schedule.js           NY-time math, tiers, hero state, service days
js/timetable.js          live timetable refresh, never-regress (shared with bake)
js/live.js               poller with watchdog + global crash guard
js/text.js               html→text, alert relevance (shared with worker)
js/ics.js  js/push.js  js/store.js  js/ui.js
data/timetable.json      baked snapshot (generated)
data/walk.json           walk-time matrix (hand-tuned)
data/seed-times.json     verified last-resort times
sw.js                    offline shell + push handling
tools/serve.mjs          dev server (auto-picks a free port)
tools/bake.mjs tools/ics.mjs tools/test.mjs tools/test-worker.mjs
worker/                  Cloudflare Worker for push (optional, free)
```

## Notes on the API

Undocumented and quirky; read `js/api.js` before changing anything:

- CORS-open (`Access-Control-Allow-Origin: *`) — why no backend is needed.
- The official GTFS feed at `passio3.com/nyu/passioTransit/gtfs/` is **empty**.
- `schedule=4` intermittently returns `{"routes":[]}` for healthy routes.
  `eta=3` with `timelineIsActive` is the reliable source.
- On `eta=3`, **omit** `position` for a stop's whole-day schedule; **pass** the
  correct position for live ETAs and a trustworthy `outOfService`. The wrong
  position leaks a SQL error.
- Live ETAs come in two shapes: a unix `arrivalTimestamp`, or only a string
  like `"24 min "`. Handle both or you silently lose real-time data.
- `getStops=2` deduplicates stops across routes; per-route order is in `routes`.
- Alert timestamps are New York wall-clock with no zone; `from` is the display
  time, `created` is authoring time. Bodies are loose HTML.
