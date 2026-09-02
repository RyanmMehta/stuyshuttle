/**
 * Live map — route lines, moving buses, and tappable stops that show the same
 * ETAs as the Trip tab (GPS-validated, so a bus that already passed is greyed
 * out instead of lying about "8 min").
 *
 * Leaflet + OpenStreetMap tiles are loaded lazily from a CDN the first time
 * this tab opens. This is the one screen that needs a network connection; the
 * rest of the app works offline.
 */
import { h, icon, fmtTime } from '../ui.js';
import { ROUTES, stopName } from '../routes.js';
import { routePolylines, classifyArrivals } from '../geo.js';
import * as api from '../api.js';

const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
const CENTER = [40.7315, -73.9855]; // between Stuytown and Washington Square
const ROUTE_KEY_BY_ID = {}; // filled per render

let map = null;
let layers = { routes: null, stops: null, buses: null };
let leafletPromise = null;
let busTimer = null;
let popupStop = null; // { stopId, routeKey } currently open

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = LEAFLET_CSS;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = LEAFLET_JS;
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('map library failed to load'));
    document.head.appendChild(js);
  });
  return leafletPromise;
}

export function renderMap(ctx) {
  const wrap = h('div', { class: 'mapwrap' },
    h('div', { id: 'leaflet', class: 'leaflet' }),
    h('div', { class: 'maplegend' },
      Object.values(ROUTES).filter((r) => r.official).map((r) =>
        h('span', { class: 'maplegend__item' }, h('span', { class: 'maplegend__dot', style: { background: r.color } }), r.name.replace('Route ', 'R'))),
      h('span', { class: 'maplegend__item' }, icon('bus', 14), 'live bus')));

  // Build after the node is in the DOM.
  setTimeout(() => initMap(ctx).catch((e) => {
    const el = document.getElementById('leaflet');
    if (el) el.innerHTML = `<div class="map-error">Map needs a connection.<br><span class="muted">${e.message}</span></div>`;
  }), 0);
  return wrap;
}

async function initMap(ctx) {
  const L = await loadLeaflet();
  const el = document.getElementById('leaflet');
  if (!el) return;

  if (!map || map._container !== el) {
    map = L.map(el, { zoomControl: true, attributionControl: true }).setView(CENTER, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    layers.routes = L.layerGroup().addTo(map);
    layers.stops = L.layerGroup().addTo(map);
    layers.buses = L.layerGroup().addTo(map);
  }
  drawStatic(L, ctx);
  drawBuses(L, ctx);

  clearInterval(busTimer);
  busTimer = setInterval(() => {
    if (document.hidden || ctx.stateTab() !== 'map') return;
    ctx.actions.refresh();
    drawBuses(L, ctx);
    if (popupStop) refreshOpenPopup(ctx);
  }, 7000);
}

export function teardownMap() { clearInterval(busTimer); busTimer = null; popupStop = null; }

/** Route lines + stop dots (static per data refresh). */
function drawStatic(L, ctx) {
  const snap = ctx.snapshot;
  layers.routes.clearLayers();
  layers.stops.clearLayers();

  const shown = Object.values(ROUTES).filter((r) => r.official);
  for (const r of shown) {
    const id = snap.routeIds?.[r.key];
    ROUTE_KEY_BY_ID[id] = r.key;
    for (const line of routePolylines(snap.routePoints?.[id])) {
      if (line.length > 1) L.polyline(line, { color: r.color, weight: 4, opacity: 0.55 }).addTo(layers.routes);
    }
  }
  // Stops we care about (Stuytown boarding + campus). Draw as colored rings.
  const drawn = new Set();
  for (const r of shown) {
    const id = snap.routeIds?.[r.key];
    for (const x of snap.sequences?.[id] || []) {
      const key = x.stopId;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const s = snap.stops?.[key];
      if (!s) continue;
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 6, color: '#fff', weight: 2, fillColor: r.color, fillOpacity: 1,
      }).addTo(layers.stops);
      m.on('click', () => openStopPopup(L, ctx, x.stopId, r.key, [s.lat, s.lon]));
      m.bindTooltip(stopName(x.stopId), { direction: 'top' });
    }
  }
}

/** Live bus markers, redrawn each tick. */
function drawBuses(L, ctx) {
  if (!layers.buses) return;
  layers.buses.clearLayers();
  for (const v of ctx.vehicles || []) {
    const key = ROUTE_KEY_BY_ID[v.routeId] || null;
    if (!key) continue; // only show the routes we actually draw (C/E/W/F)
    const color = ROUTES[key].color;
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    const icon = L.divIcon({
      className: 'busmarker',
      html: `<div class="busmarker__dot" style="background:${color}"><span style="transform:rotate(${v.heading || 0}deg)">▲</span></div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    L.marker([v.lat, v.lon], { icon })
      .addTo(layers.buses)
      .bindTooltip(`${v.routeName} · bus ${v.name}${Number.isFinite(v.load) ? ` · ${v.load}/${v.capacity}` : ''}`, { direction: 'top' });
  }
}

async function openStopPopup(L, ctx, stopId, routeKey, latlng) {
  popupStop = { stopId, routeKey };
  const popup = L.popup({ maxWidth: 300, className: 'stoppopup' }).setLatLng(latlng)
    .setContent(popupHtml(stopId, routeKey, null, 'Loading…')).openOn(map);
  const data = await fetchStopEtas(ctx, stopId, routeKey).catch(() => null);
  if (popupStop && popupStop.stopId === stopId) popup.setContent(popupHtml(stopId, routeKey, data));
}

async function refreshOpenPopup(ctx) {
  if (!map || !popupStop) return;
  const p = map._popup; // Leaflet keeps the open popup here
  if (!p) return;
  const data = await fetchStopEtas(ctx, popupStop.stopId, popupStop.routeKey).catch(() => null);
  if (popupStop) p.setContent(popupHtml(popupStop.stopId, popupStop.routeKey, data));
}

/** ETAs for one stop on one route, GPS-classified. */
async function fetchStopEtas(ctx, stopId, routeKey) {
  const snap = ctx.snapshot;
  const routeId = snap.routeIds?.[routeKey];
  const position = (snap.sequences?.[routeId] || []).find((x) => x.stopId === stopId)?.position;
  if (!routeId || !position) return { arrivals: [], routeKey };
  const eta = await api.getEta(stopId, routeId, position);
  const classified = classifyArrivals(eta.arrivals, {
    vehicles: ctx.vehicles, sequence: snap.sequences?.[routeId] || [], stops: snap.stops || {},
    targetStopId: stopId, routeName: ROUTES[routeKey]?.name, now: Date.now(),
  });
  return { classified, outOfService: eta.outOfService, scheduleTimes: eta.scheduleTimes, routeKey };
}

/**
 * Pure popup model — what to show for a stop, given classified arrivals. Kept
 * free of DOM/Date so it can be unit-tested (tools/test-map.mjs).
 * @returns { rows: [{kind:'live'|'estimate'|'passed', bus, label}], note }
 */
export function stopPopupModel(data, now = Date.now()) {
  if (!data) return { rows: [], note: 'Couldn’t load ETAs.' };
  if (data.outOfService) return { rows: [], note: 'Not running right now.' };
  const c = data.classified || { live: [], estimate: [], passed: [] };
  const mins = (a) => Math.max(0, Math.round((a.arrivalAt - now) / 60000));
  const rows = [];
  for (const a of c.live) rows.push({ kind: 'live', bus: a.vehicle || '', label: mins(a) <= 0 ? 'due' : `${mins(a)} min` });
  for (const a of c.estimate) rows.push({ kind: 'estimate', bus: a.vehicle || '', label: `~${mins(a)} min` });
  for (const a of c.passed) rows.push({ kind: 'passed', bus: a.vehicle || '', label: 'passed' });
  let note = null;
  if (!c.live.length && !c.estimate.length) {
    const next = (data.scheduleTimes || []).find(Boolean);
    note = `No bus tracking toward this stop.${next ? ` Next scheduled ${next}.` : ''}`;
  }
  return { rows, note };
}

function popupHtml(stopId, routeKey, data, loading) {
  const color = ROUTES[routeKey]?.color || '#555';
  const head = `<div class="sp__head"><span class="sp__chip" style="background:${color}">${routeKey}</span><b>${stopName(stopId)}</b></div>`;
  if (loading) return `${head}<div class="sp__muted">${loading}</div>`;
  const now = Date.now();
  const { rows, note } = stopPopupModel(data, now);
  const tag = { live: '<span class="sp__tag">live</span>', estimate: '<span class="sp__tag sp__tag--est">estimate</span>', passed: '<span class="sp__tag">already went by</span>' };
  const html = rows.map((r) =>
    `<div class="sp__row${r.kind === 'passed' ? ' sp__row--passed' : ''}"><span class="sp__dot sp__dot--${r.kind === 'estimate' ? 'est' : r.kind}"></span><span class="sp__bus">Bus ${r.bus}</span><span class="sp__min">${r.label}</span>${tag[r.kind]}</div>`).join('');
  const body = html + (note ? `<div class="sp__muted">${note}</div>` : '');
  return `${head}<div class="sp__list">${body}</div><div class="sp__foot">GPS-checked · updated ${fmtTime(now)}</div>`;
}
