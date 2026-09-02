/**
 * Text helpers that must work in both the browser and Node (the bake script),
 * so no DOM here.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', bull: '•',
};

/**
 * Passio sends alert bodies as loose HTML ("<br> <p>\n <b>…"). Convert to plain
 * text with line breaks preserved. We never inject their HTML into the page.
 */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * NYU posts alerts for every service it runs — Brooklyn, the Langone ferry,
 * the Midtown commuter shuttles — all with routeId null. This heuristic is
 * deliberately conservative: an alert is "other service" only if it mentions a
 * service we never use AND nothing we do use. Ambiguous stays relevant.
 */
const OTHER_SERVICES = /\b(ferry|langone|cobble hill|brooklyn|metrotech|commuter shuttle|\bbat\b)/i;
const OUR_SERVICES = /\b(route [cef]\b|stuyvesant|stuytown|washington square|14th|avenue [abc]|715 broadway|all colleges|all routes|all shuttle|shuttle service)/i;

export function isRelevantAlert(text) {
  if (OUR_SERVICES.test(text || '')) return true;
  return !OTHER_SERVICES.test(text || '');
}
