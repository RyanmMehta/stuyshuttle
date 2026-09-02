#!/usr/bin/env node
/**
 * Local dev server. Picks a free port automatically, so it can never fail with
 * "Address already in use" the way `python3 -m http.server 8777` did.
 *
 *   node tools/serve.mjs            # starts on 8777, or the next free port
 *   node tools/serve.mjs 9000       # prefer a specific port
 *
 * Sends Cache-Control: no-store so edits show up on plain reload. The service
 * worker still caches the shell for offline use; to see brand-new code after
 * editing sw.js, bump VERSION there or hard-reload once.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFERRED = Number(process.argv[2]) || 8777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ics': 'text/calendar; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  // Keep requests inside the project directory.
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('Not found'); }
  if (st.isDirectory()) { res.writeHead(301, { Location: path + '/' }); return res.end(); }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    // Lets the page be installed as a PWA from localhost without extra headers.
    'Service-Worker-Allowed': '/',
  });
  createReadStream(file).pipe(res);
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`  port ${port} is busy, trying ${port + 1}`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('could not start server:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    const lan = Object.values(networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    console.log(`\nStuyShuttle dev server\n`);
    console.log(`  Mac:     http://localhost:${port}`);
    if (lan) console.log(`  Phone:   http://${lan}:${port}   (same Wi-Fi; offline mode + push need https, so use GitHub Pages for the real install)`);
    console.log(`\n  Ctrl-C to stop\n`);
  });
}

listen(PREFERRED, 20);
