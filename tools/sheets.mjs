#!/usr/bin/env node
/**
 * Pulls NYU's OFFICIAL timetables — the Google Sheets linked from
 * nyu.edu/…/routes-and-schedules — and writes data/official.json.
 *
 * Why this exists: the Passio API is the live source, but it (a) re-creates
 * routes under new IDs between semesters, (b) intermittently returns empty
 * schedules, (c) never publishes the 715 Broadway ARRIVAL time, and (d) has
 * no Friday/weekend variants exposed. The sheets have all of that, and they
 * are what NYU itself publishes.
 *
 *   node tools/sheets.mjs
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = `${ROOT}/data/official.json`;

/** Sheet IDs from nyu.edu route pages (Academic Year 2026-27). */
export const SHEETS = {
  C: { monthu: '1wH6RglHPsZBphe8oelFEsv-_LyiVxjj7ygfyJ26Hbzg' },
  E: { monthu: '1shK20dC2NbZu87IAejKz6AG3Bylm8DUKZjoqBIUsipQ', fri: '1rD9DAfBdaVqnZF8ubHju-gJxl8GSW4ETXMhEECy42rU' },
  W: { weekend: '15a2dYG8jU1ondCk7accxpBOvCbBxnZMrG6eOhho8LRM' },
};
export const DAY_TYPES = { C: { 1: 'monthu', 2: 'monthu', 3: 'monthu', 4: 'monthu' },
  E: { 1: 'monthu', 2: 'monthu', 3: 'monthu', 4: 'monthu', 5: 'fri' },
  W: { 0: 'weekend', 6: 'weekend' } };

const csvUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;

/** Minimal CSV parser (handles quoted cells). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Normalise a stop name so "1st Ave. at 17th St." ≈ "First Avenue At 17th Street". */
export function normStop(name) {
  return String(name).toLowerCase()
    .replace(/\(eb\)|eastbound/g, ' eb ').replace(/\(wb\)|westbound/g, ' wb ')
    .replace(/\b(departure|arrival)\b/g, ' ')
    .replace(/\b1st\b/g, 'first').replace(/\b2nd\b/g, 'second').replace(/\b3rd\b/g, 'third')
    .replace(/\bave\.?\b/g, 'avenue').replace(/\bst\.?\b/g, 'street').replace(/\be\.?\s+(?=\d)/g, '')
    .replace(/\bpl\.?\b/g, 'place').replace(/\b(at|and|&)\b/g, ' ')
    .replace(/\bnyu langone (health|medical center)\b/g, 'nyu langone health')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Explicit column → Passio stopId overrides (checked first). */
const OVERRIDES = {
  '20th st loop exit': '6556', 'avenue c 18th street': '6557', 'avenue c 16th street': '6558',
  'avenue c 14th street': '6559', '14th street avenue b': '6560', '14th street avenue a': '6561',
  '14th street first avenue': '6562', 'third avenue 13th street': '6563', '715 broadway': '6545',
  '14th street irving place eb': '6564', '14th street third avenue': '6580', 'first avenue 17th street': '6566',
  'first avenue 24th street': '6567', 'first avenue 26th street': '6568', 'nyu langone health': '13110',
  'lexington avenue 31st street': '6570', 'gramercy green': '6571', 'third avenue 17th street': '13118',
  '14th street irving place wb': '6573', 'broadway broome street': '6550', '80 lafayette street': '6551',
  'centre street broome street': '9296', 'cleveland place spring street': '9296',
};

function mapColumn(header, passioStops) {
  const kind = /arrival/i.test(header) ? 'arrival' : /departure/i.test(header) ? 'departure' : 'stop';
  const n = normStop(header);
  let stopId = OVERRIDES[n] || null;
  if (!stopId) {
    // fuzzy: best token overlap with Passio names
    const toks = new Set(n.split(' ').filter((t) => t.length > 1));
    let best = null, bestScore = 0;
    for (const s of Object.values(passioStops)) {
      const st = new Set(normStop(s.name).split(' '));
      const overlap = [...toks].filter((t) => st.has(t)).length;
      const score = overlap / Math.max(1, Math.max(toks.size, st.size));
      if (score > bestScore) { bestScore = score; best = s.id; }
    }
    if (bestScore >= 0.6) stopId = best;
  }
  return { header, kind, stopId, name: stopId ? passioStops[stopId]?.name : null };
}

const TIME_RE = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;

export function parseSheet(csvText, passioStops) {
  const rows = parseCsv(csvText).map((r) => r.map((c) => c.trim()));
  // header = first row with ≥3 time-looking follow-ups… simpler: first row containing "715 Broadway"
  const hi = rows.findIndex((r) => r.some((c) => /715 broadway/i.test(c)));
  if (hi < 0) throw new Error('no header row found');
  const notes = rows.slice(0, hi).flat().filter(Boolean);
  const headers = rows[hi].map((h) => h.trim()).filter((h, i, a) => h && !/internal use/i.test(h) || false);
  const columns = rows[hi].map((h) => (h && !/internal use/i.test(h) ? mapColumn(h, passioStops) : null));
  const trips = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r.some((c) => TIME_RE.test(c))) continue;
    trips.push(columns.map((col, i) => (col && TIME_RE.test(r[i] || '') ? r[i].replace(/\s+/g, ' ').toUpperCase() : null)));
  }
  const cols = columns.filter(Boolean);
  return {
    notes,
    columns: cols,
    // trips as arrays aligned to `cols`
    trips: trips.map((t) => t.filter((_, i) => columns[i])),
  };
}

/** Fetch and parse every official sheet. Exported so bake.mjs can call it. */
export async function fetchOfficial(passioStops, log = () => {}) {
  const out = { fetchedAt: new Date().toISOString(), sources: {}, dayTypes: DAY_TYPES, routes: {} };
  for (const [route, byDay] of Object.entries(SHEETS)) {
    out.routes[route] = {};
    for (const [dayType, id] of Object.entries(byDay)) {
      const url = csvUrl(id);
      out.sources[`${route}_${dayType}`] = url;
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${route} ${dayType}: HTTP ${res.status}`);
      const parsed = parseSheet(await res.text(), passioStops);
      out.routes[route][dayType] = parsed;
      const unmapped = parsed.columns.filter((c) => !c.stopId).map((c) => c.header);
      log(`  Route ${route} ${dayType}: ${parsed.trips.length} trips × ${parsed.columns.length} stops` +
        (unmapped.length ? `  UNMAPPED: ${unmapped.join(' | ')}` : '') + `\n      ${parsed.notes.filter((n) => /effect/i.test(n)).join(' ')}`);
    }
  }
  return out;
}

const main = async () => {
  const snapshotPath = `${ROOT}/data/timetable.json`;
  const passioStops = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')).stops : {};
  const out = await fetchOfficial(passioStops, console.log);
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\nWrote data/official.json`);
};
const _unused = async () => {
  const out = { fetchedAt: new Date().toISOString(), sources: {}, dayTypes: DAY_TYPES, routes: {} };
  for (const [route, byDay] of Object.entries(SHEETS)) {
    out.routes[route] = {};
    for (const [dayType, id] of Object.entries(byDay)) {
      const url = csvUrl(id);
      out.sources[`${route}_${dayType}`] = url;
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${route} ${dayType}: HTTP ${res.status}`);
      const parsed = parseSheet(await res.text(), passioStops);
      out.routes[route][dayType] = parsed;
      const unmapped = parsed.columns.filter((c) => !c.stopId).map((c) => c.header);
      console.log(`  Route ${route} ${dayType}: ${parsed.trips.length} trips × ${parsed.columns.length} stops` +
        (unmapped.length ? `  UNMAPPED: ${unmapped.join(' | ')}` : '') + `\n      ${parsed.notes.filter((n) => /effect/i.test(n)).join(' ')}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\nWrote data/official.json`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('sheets failed:', e.message); process.exit(1); });
}
