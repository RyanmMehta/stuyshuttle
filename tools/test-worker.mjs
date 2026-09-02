// Exercise the worker's pure decision helpers against realistic inputs.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker/src/index.js', import.meta.url),'utf8');

// Pull out the pure helpers we want to test. The worker imports the web-push
// library (not needed here) and the shared text helpers (re-imported below by
// absolute URL, since a data: module can't resolve relative paths).
const textUrl = new URL('../js/text.js', import.meta.url).href;
const body = src
  .replace(/^import .*$/gm, '')
  .replace(/^export default \{[\s\S]*?\n\};$/m, '');
const mod = await import('data:text/javascript,' + encodeURIComponent(
  `import { htmlToText, isRelevantAlert } from '${textUrl}';\n` +
  body + '\nexport { checkWindow, parseEtaText, parseClock, fmt };'
));

let pass=0, fail=0;
const ck=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`  ${ok?'PASS':'FAIL'}  ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

console.log('\n== clock formatting ==');
ck('450 -> 7:30 AM', mod.fmt(450), '7:30 AM');
ck('720 -> 12:00 PM', mod.fmt(720), '12:00 PM');
ck('1005 -> 4:45 PM', mod.fmt(1005), '4:45 PM');
ck('0 -> 12:00 AM', mod.fmt(0), '12:00 AM');

console.log('\n== parseClock ==');
ck('7:30 AM', mod.parseClock('7:30 AM'), 450);
ck('12:40 PM', mod.parseClock('12:40 PM'), 760);
ck('junk', mod.parseClock('soon'), null);

console.log('\n== parseEtaText ==');
ck('24 min', mod.parseEtaText('24 min '), 24);
ck('1h 11min', mod.parseEtaText('1h 11min '), 71);
ck('--', mod.parseEtaText('--'), null);
ck('1-2 min → 1', mod.parseEtaText('1-2 min'), 1);

console.log('\n== service window (DST-safe, local NY time) ==');
// checkWindow(now).morning: Mon–Fri 06:45–11:15 New York time. Covers Route C
// (Mon–Thu) and Route E's Friday morning runs. Alerts relay at any hour.
const w = (iso) => mod.checkWindow(new Date(iso)).morning;
// 2026-09-02 is a Wednesday. 12:00 UTC = 8:00 AM EDT.
ck('Wed 8am EDT active',            w('2026-09-02T12:00:00Z'), true);
ck('Wed 6:30am EDT inactive',       w('2026-09-02T10:30:00Z'), false);
ck('Wed 6:45am EDT active (start)', w('2026-09-02T10:45:00Z'), true);
ck('Wed 11:15am EDT active (end)',  w('2026-09-02T15:15:00Z'), true);
ck('Wed 11:20am EDT inactive',      w('2026-09-02T15:20:00Z'), false);
ck('Tue 10pm EDT inactive',         w('2026-09-02T02:00:00Z'), false);
ck('Fri 8am active (Route E runs)', w('2026-09-04T12:00:00Z'), true);
ck('Sat 8am inactive',              w('2026-09-05T12:00:00Z'), false);
ck('Sun 8am inactive',              w('2026-09-06T12:00:00Z'), false);
// Winter: 2026-12-02 is a Wednesday. 13:00 UTC = 8:00 AM EST.
ck('Winter Wed 8am EST active',     w('2026-12-02T13:00:00Z'), true);
ck('Winter Wed 7am EST active',     w('2026-12-02T12:00:00Z'), true);
ck('Winter Wed 6am EST inactive',   w('2026-12-02T11:00:00Z'), false);
// The old summer-only cron range would have stopped at 15:00 UTC = 10:00 AM EST;
// the window must still be open at 11:00 AM EST = 16:00 UTC.
ck('Winter Wed 11am EST active',    w('2026-12-02T16:00:00Z'), true);

console.log(`\n${fail?'FAILURES':'ALL PASS'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
