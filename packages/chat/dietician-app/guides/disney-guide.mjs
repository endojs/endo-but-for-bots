// guides/disney-guide.mjs — the Disneyland Food Guide, ported from disneyland-food-guide/gen_guide.py (the
// richest persona generator): VIABLE/BORDERLINE Disney-resort places grouped by PARK, an "Around the Hotel"
// section (non-Disney picks within a radius of a trip hotel), and TWO hand-built inline-SVG maps (resort
// land-cluster map + hotel-radius map). The trip constants (hotel, parks, tints) are PARAMETERIZED via a
// `trip` object (defaults to dan's Disneyland trip). Reuses shared.card/esc/dishHtml. Plain node.
import { esc, card } from './shared.mjs';

// dan's trip — the default. Override `trip` to retarget the guide to a different resort/hotel.
export const DEFAULT_TRIP = {
  parkOrder: ['Disneyland Park', 'Disney California Adventure', 'Downtown Disney District'],
  parkZone: { 'Disneyland Park': 'dlr', 'Disney California Adventure': 'dca', 'Downtown Disney District': 'ddd' },
  parkTint: { 'Disneyland Park': '#1b2a3a', 'Disney California Adventure': '#1c2e22', 'Downtown Disney District': '#2e2418' },
  parkFallback: 'Disneyland Resort',
  hotel: { lat: 33.81161, lng: -117.9126697, name: 'Home2 Suites Anaheim', addr: '1441 S Manchester Ave', radiusMi: 6.0 },
};

const parkOf = (addr, parkOrder, fallback) => { for (const p of parkOrder) if ((addr || '').includes(p)) return p; return fallback; };
const areaOf = addr => (addr || '').split(',')[0].trim();
export const haversineMi = (lat1, lng1, lat2, lng2) => {
  const R = 3958.8;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
const viableFirst = (a, b) => (a.verdict === 'VIABLE' ? 0 : 1) - (b.verdict === 'VIABLE' ? 0 : 1)
  || (String(a.name || '') < String(b.name || '') ? -1 : String(a.name || '') > String(b.name || '') ? 1 : 0);

// the resort map: dots clustered per land, colliding land-centroids fanned out, each dot a card anchor.
const svgMap = (rows, trip) => {
  const areas = {};
  for (const r of rows) {
    if (!r.lat || !r.lng) continue;
    const a = areaOf(r.address || '') || 'Unknown';
    if (!areas[a]) areas[a] = { lat: r.lat, lng: r.lng, park: parkOf(r.address || '', trip.parkOrder, trip.parkFallback), items: [] };
    areas[a].items.push(r);
  }
  if (!Object.keys(areas).length) return '';

  // spread colliding centroids (the DB stores approximate per-land coords) — deterministic circular fan-out
  const groups = {};
  for (const name of Object.keys(areas).sort()) {
    const key = `${areas[name].lat.toFixed(4)},${areas[name].lng.toFixed(4)}`;
    (groups[key] = groups[key] || []).push(name);
  }
  const R = 0.00065;
  for (const names of Object.values(groups)) {
    if (names.length === 1) continue;
    names.forEach((name, i) => { const ang = (2 * Math.PI * i) / names.length - Math.PI / 2; areas[name].lng += R * Math.cos(ang); areas[name].lat += R * Math.sin(ang); });
  }

  const vals = Object.values(areas);
  const lats = vals.map(a => a.lat), lngs = vals.map(a => a.lng);
  const LAT_MIN = Math.min(...lats) - 0.0012, LAT_MAX = Math.max(...lats) + 0.0024;
  const LNG_MIN = Math.min(...lngs) - 0.0016, LNG_MAX = Math.max(...lngs) + 0.0016;
  const W = 860, H = 560;
  const toXy = (lat, lng) => [((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * W, ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * H];
  const rDot = 6.5, gap = 4, step = 2 * rDot + gap, LABEL_H = 22;
  const geom = {};
  for (const [name, a] of Object.entries(areas)) {
    const [cx, cy] = toXy(a.lat, a.lng);
    const n = a.items.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rowsN = Math.max(1, Math.ceil(n / cols));
    const cw = cols * step - gap, ch = rowsN * step - gap;
    geom[name] = { cx, cy, cols, cw, ch, left: cx - cw / 2, right: cx + cw / 2, top: cy - ch / 2 - LABEL_H, bot: cy + ch / 2 };
  }

  const f0 = v => v.toFixed(0), f1 = v => v.toFixed(1);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" class="dl-map" role="img" aria-label="Resort map with color-coded restaurants" preserveAspectRatio="xMidYMid meet">`];

  const parkAreas = {};
  for (const [name, a] of Object.entries(areas)) (parkAreas[a.park] = parkAreas[a.park] || []).push(name);
  for (const [park, names] of Object.entries(parkAreas)) {
    const l = Math.min(...names.map(n => geom[n].left)), r = Math.max(...names.map(n => geom[n].right));
    const t = Math.min(...names.map(n => geom[n].top)), b = Math.max(...names.map(n => geom[n].bot));
    const pad = 16, x0 = l - pad, x1 = r + pad, y0 = t - pad - 22, y1 = b + pad;
    const tint = trip.parkTint[park] || '#222a36';
    parts.push(`<rect x="${f0(x0)}" y="${f0(y0)}" width="${f0(x1 - x0)}" height="${f0(y1 - y0)}" rx="22" class="park-region" style="fill:${tint}" />`);
    parts.push(`<text x="${f0(x0 + 14)}" y="${f0(y0 + 22)}" class="park-label">${esc(park)}</text>`);
  }

  for (const [name, a] of Object.entries(areas)) {
    const g = geom[name];
    const items = a.items.slice().sort(viableFirst);
    if (name !== a.park) parts.push(`<text x="${f0(g.cx)}" y="${f0(g.cy - g.ch / 2 - 8)}" class="area-label" text-anchor="middle">${esc(name)}</text>`);
    items.forEach((r, i) => {
      const col = i % g.cols, row = Math.floor(i / g.cols);
      const x = g.cx - g.cw / 2 + col * step + rDot, y = g.cy - g.ch / 2 + row * step + rDot;
      const klass = r.verdict === 'VIABLE' ? 'viable' : 'borderline';
      parts.push(`<a href="#card-${esc(r.slug || '')}"><circle cx="${f1(x)}" cy="${f1(y)}" r="${rDot}" class="dot ${klass}"><title>${esc(r.name || '')} — ${r.verdict === 'VIABLE' ? 'Safe bet' : 'With care'}</title></circle></a>`);
    });
  }
  parts.push('</svg>');
  return parts.join('\n');
};

// the hotel mini-map: 1/3/5-mile rings + jittered dots + hotel marker (per-axis px/mile for true circles).
const hotelMap = (rows, trip) => {
  if (!rows.length) return '';
  const { hotel } = trip;
  const lats = [hotel.lat, ...rows.map(r => r.lat)], lngs = [hotel.lng, ...rows.map(r => r.lng)];
  const LAT_MIN = Math.min(...lats) - 0.006, LAT_MAX = Math.max(...lats) + 0.010;
  const LNG_MIN = Math.min(...lngs) - 0.010, LNG_MAX = Math.max(...lngs) + 0.010;
  const W = 860, H = 480;
  const toXy = (lat, lng) => [((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * W, ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * H];
  const degPerPxY = (LAT_MAX - LAT_MIN) / H, degPerPxX = (LNG_MAX - LNG_MIN) / W;
  const pxPerMiY = 1 / (degPerPxY * 69.0), pxPerMiX = 1 / (degPerPxX * 69.0 * Math.cos((hotel.lat * Math.PI) / 180));
  const f0 = v => v.toFixed(0), f1 = v => v.toFixed(1);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" class="dl-map hotel-map" role="img" aria-label="Map of restaurants near ${esc(hotel.name)}" preserveAspectRatio="xMidYMid meet">`];
  const [hx, hy] = toXy(hotel.lat, hotel.lng);
  for (const miles of [1, 3, 5]) {
    const rx = miles * pxPerMiX, ry = miles * pxPerMiY;
    parts.push(`<ellipse cx="${f0(hx)}" cy="${f0(hy)}" rx="${f0(rx)}" ry="${f0(ry)}" class="ring" />`);
    parts.push(`<text x="${f0(hx + rx - 4)}" y="${f0(hy - 4)}" class="ring-label" text-anchor="end">${miles}mi</text>`);
  }
  const placed = [];
  for (const r of rows) {
    let [cx, cy] = toXy(r.lat, r.lng);
    for (const [px, py] of placed) {
      const d2 = (cx - px) ** 2 + (cy - py) ** 2;
      if (d2 < 16 * 16) { const dx = cx - px, dy = cy - py; const norm = Math.sqrt(dx * dx + dy * dy) || 1; cx += (dx / norm) * 12; cy += (dy / norm) * 12; }
    }
    placed.push([cx, cy]);
    const klass = r.verdict === 'VIABLE' ? 'viable' : 'borderline';
    parts.push(`<a href="#card-${esc(r.slug || '')}"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="7" class="dot ${klass}"><title>${esc(r.name || '')} — ${r.dist_mi}mi — ${r.verdict === 'VIABLE' ? 'Safe bet' : 'With care'}</title></circle></a>`);
  }
  parts.push(`<circle cx="${f0(hx)}" cy="${f0(hy)}" r="11" class="hotel-marker" />`);
  parts.push(`<circle cx="${f0(hx)}" cy="${f0(hy)}" r="4" class="hotel-dot" />`);
  parts.push(`<text x="${f0(hx)}" y="${f0(hy + 26)}" class="hotel-label" text-anchor="middle">${esc(hotel.name)}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
};

// a hotel-area card = the shared card with the area meta swapped for "<city> · <dist> mi from hotel".
const hotelCard = r => {
  const seg = (r.address || '').split(',').map(s => s.trim()).filter(Boolean);
  const city = seg.length >= 3 ? seg[seg.length - 3] : '';
  return card({ ...r, primary_type: '', city }, { extraMeta: [`${r.dist_mi ?? '?'} mi from hotel`] });
};

const DEFAULT_HOWTO = `    <ul>
      <li><strong>Ask for the Special Diets / allergy-trained Cast Member or chef.</strong> At table-service spots they'll walk the menu with you. Disney's standard allergen menus only cover the top-8 — they do <em>not</em> flag onion, garlic, or histamine, so you must ask directly.</li>
      <li><strong>Say it plainly:</strong> no onion, no garlic (including powder &amp; in sauces/marinades/stocks), no soy sauce, no vinegar, no aged cheese, no cured/smoked meats, no tomato.</li>
      <li><strong>Your safe template:</strong> freshly grilled or seared protein (fish/chicken/pork/eggs) + plain rice or potato + steamed or sautéed plain veg, dressed with olive oil, butter, salt or lemon only.</li>
      <li><strong>Bring your enzymes:</strong> NaturDAO 10–15 min before histamine-containing meals; FODZYME on the first bite if fructans are likely. They reduce, not eliminate, risk.</li>
      <li><strong>Freshness matters:</strong> favor cook-to-order kitchens over batch-prepped counters; skip anything that's been sitting.</li>
    </ul>`;

// parkRows = merged Disney VIABLE/BORDERLINE rows; hotelRows = nearby non-Disney rows (each w/ dist_mi).
export const generateDisneyGuide = (parkRows, hotelRows, { person = 'alexa', today = '', trip = DEFAULT_TRIP, howtoHtml = DEFAULT_HOWTO, companionUrl = '', tagline } = {}) => {
  const name = person ? person.charAt(0).toUpperCase() + person.slice(1) : 'the diner';
  const { parkOrder, parkZone, hotel } = trip;

  const byPark = {};
  for (const p of parkOrder) byPark[p] = [];
  for (const r of parkRows) (byPark[parkOf(r.address || '', parkOrder, trip.parkFallback)] = byPark[parkOf(r.address || '', parkOrder, trip.parkFallback)] || []).push(r);
  for (const p of Object.keys(byPark)) byPark[p].sort(viableFirst);

  const nViable = parkRows.filter(r => r.verdict === 'VIABLE').length;
  const nBorder = parkRows.filter(r => r.verdict === 'BORDERLINE').length;

  const sections = [];
  for (const p of parkOrder) {
    const items = byPark[p] || [];
    if (!items.length) continue;
    const nv = items.filter(r => r.verdict === 'VIABLE').length;
    const nb = items.length - nv;
    sections.push(`<section data-zone="${parkZone[p] || ''}"><h2>${esc(p)} <span class="count">${nv} safe · ${nb} with care</span></h2>`);
    sections.push('<div class="grid">');
    for (const r of items) sections.push(card({ ...r, city: areaOf(r.address || '') }));
    sections.push('</div></section>');
  }
  const body = sections.join('\n');
  const mapSvg = svgMap(parkRows, trip);

  const nHotelViable = hotelRows.filter(r => r.verdict === 'VIABLE').length;
  const nHotelBorder = hotelRows.length - nHotelViable;
  let hotelSection = '';
  if (hotelRows.length) {
    hotelSection = `
  <section class="hotel-section" data-zone="hotel">
    <h2>Around the Hotel — Anaheim <span class="count">${nHotelViable} safe · ${nHotelBorder} with care</span></h2>
    <p class="hotel-intro">Within ~${Math.round(hotel.radiusMi)} miles of <strong>${esc(hotel.name)}</strong> (${esc(hotel.addr)}). Useful for breakfast before the parks and any meal you take outside the resort. Same rules as Disney: ask, modify, and bring enzymes.</p>
    <div class="map-wrap">
      ${hotelMap(hotelRows, trip)}
    </div>
    <div class="grid" style="margin-top:18px">
      ${hotelRows.map(hotelCard).join('\n')}
    </div>
  </section>
`;
  }
  const companion = companionUrl ? `\n    <p>A companion to the <a href="${esc(companionUrl)}" rel="noopener noreferrer">Feeding ${esc(name)}</a> guide.</p>` : '';
  const sub = tagline || 'your dietary constraints — gluten-free, low-histamine / low-FODMAP';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Disneyland Food Guide — for ${esc(name)}</title>
<script src="sort.js" defer></script>
<style>
  :root {
    --bg:#0e1116; --panel:#171c24; --panel2:#1e2530; --ink:#e8edf3; --muted:#9aa7b6;
    --green:#2ecc71; --greendim:#143524; --yellow:#f5c451; --yellowdim:#3a3115;
    --line:#2a323d; --accent:#6db3ff;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:28px 20px 18px; background:linear-gradient(160deg,#1b2330,#10141b); border-bottom:1px solid var(--line); }
  header h1 { margin:0 0 6px; font-size:1.5rem; }
  header p { margin:4px 0; color:var(--muted); font-size:.95rem; }
  .wrap { max-width:920px; margin:0 auto; padding:0 16px 64px; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 0; font-size:.85rem; color:var(--muted); }
  .pill { padding:2px 10px; border-radius:999px; font-weight:600; }
  .pill.g { background:var(--greendim); color:var(--green); }
  .pill.y { background:var(--yellowdim); color:var(--yellow); }
  .howto { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin:22px 0; }
  .howto h2 { margin:0 0 8px; font-size:1.05rem; }
  .howto ul { margin:8px 0 0; padding-left:18px; }
  .howto li { margin:5px 0; color:#cdd6e0; }
  section { margin:30px 0 0; }
  section > h2 { font-size:1.2rem; border-bottom:1px solid var(--line); padding-bottom:8px;
    display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .count { font-size:.78rem; color:var(--muted); font-weight:400; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; margin-top:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-left-width:4px; border-radius:12px; padding:14px 16px; }
  .card.viable { border-left-color:var(--green); }
  .card.borderline { border-left-color:var(--yellow); }
  .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
  .card h3 { margin:0 0 2px; font-size:1.06rem; }
  .badge { font-size:.72rem; font-weight:700; padding:3px 8px; border-radius:999px; white-space:nowrap; }
  .badge.viable { background:var(--greendim); color:var(--green); }
  .badge.borderline { background:var(--yellowdim); color:var(--yellow); }
  .meta { margin:2px 0 8px; font-size:.78rem; color:var(--muted); text-transform:capitalize; }
  .summary { margin:8px 0; font-size:.92rem; color:#d4dce6; }
  .label { margin:12px 0 4px; font-size:.72rem; letter-spacing:.04em; text-transform:uppercase; color:var(--accent); font-weight:700; }
  ul.dishes { list-style:none; margin:0; padding:0; }
  li.dish { background:var(--panel2); border-radius:8px; padding:8px 10px; margin:6px 0; }
  .dish-name { display:block; font-weight:600; font-size:.92rem; }
  .mod { display:block; font-size:.85rem; color:#cdd6e0; margin-top:2px; }
  .risk { display:block; font-size:.78rem; color:var(--yellow); margin-top:3px; }
  .avoid { margin:2px 0 0; font-size:.85rem; color:#e6b3b3; }
  .flex { margin:10px 0 0; font-size:.82rem; color:var(--muted); }
  .menu { margin:10px 0 0; font-size:.85rem; }
  .menu a, footer a { color:var(--accent); }
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:.8rem; }
  .map-section { margin:22px 0 0; }
  .map-wrap { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:10px; margin-top:12px; overflow:hidden; }
  .dl-map { display:block; width:100%; height:auto; }
  .dl-map .park-region { stroke:#3a4453; stroke-width:1; opacity:0.85; }
  .dl-map .park-label { fill:#cfd6df; font-size:13px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
  .dl-map .area-label { fill:#9aa7b6; font-size:11px; font-weight:600; paint-order:stroke; stroke:#0e1116; stroke-width:3px; }
  .dl-map .dot { stroke:#0e1116; stroke-width:1.2; cursor:pointer; transition:transform .12s ease, filter .12s ease; transform-box:fill-box; transform-origin:center; }
  .dl-map .dot.viable { fill:var(--green); }
  .dl-map .dot.borderline { fill:var(--yellow); }
  .dl-map a:hover .dot, .dl-map a:focus .dot { transform:scale(1.35); filter:brightness(1.2) drop-shadow(0 0 4px rgba(255,255,255,.35)); }
  .dl-map a:focus { outline:none; }
  .card:target { box-shadow:0 0 0 2px var(--accent), 0 0 14px rgba(109,179,255,.35); }
  .hotel-section { margin-top:40px; padding-top:8px; border-top:1px dashed var(--line); }
  .hotel-intro { color:#cdd6e0; font-size:.92rem; margin:10px 0 14px; }
  .hotel-map .ring { fill:none; stroke:#3a4453; stroke-dasharray:3 5; opacity:.7; }
  .hotel-map .ring-label { fill:#5a6677; font-size:10px; font-weight:600; paint-order:stroke; stroke:#171c24; stroke-width:3px; }
  .hotel-map .hotel-marker { fill:var(--accent); opacity:.22; stroke:var(--accent); stroke-width:1.5; }
  .hotel-map .hotel-dot { fill:var(--accent); }
  .hotel-map .hotel-label { fill:var(--accent); font-size:11px; font-weight:700; paint-order:stroke; stroke:#0e1116; stroke-width:3px; }
  .card h3 a.card-link { color:inherit; text-decoration:none; border-bottom:1px dashed rgba(109,179,255,.45); }
  .card h3 a.card-link:hover, .card h3 a.card-link:focus { color:var(--accent); border-bottom-color:var(--accent); }
  .card h3 a.card-link:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }
  .zone-toggle { position:absolute; opacity:0; pointer-events:none; width:0; height:0; }
  .tabs { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:6px; max-width:920px; margin:0 auto; padding:10px 16px;
    background:rgba(14,17,22,.92); backdrop-filter:saturate(160%) blur(6px); border-bottom:1px solid var(--line); }
  .tab { padding:7px 13px; border-radius:999px; cursor:pointer; background:var(--panel); border:1px solid var(--line); color:var(--muted);
    font-size:.85rem; font-weight:600; user-select:none; line-height:1; transition:background .12s ease, color .12s ease, border-color .12s ease; }
  .tab:hover { background:var(--panel2); color:var(--ink); }
  #z-all:checked   ~ .tabs label[for="z-all"],
  #z-dlr:checked   ~ .tabs label[for="z-dlr"],
  #z-dca:checked   ~ .tabs label[for="z-dca"],
  #z-ddd:checked   ~ .tabs label[for="z-ddd"],
  #z-hotel:checked ~ .tabs label[for="z-hotel"] { background:var(--accent); color:#0e1116; border-color:var(--accent); }
  #z-all:focus-visible   ~ .tabs label[for="z-all"],
  #z-dlr:focus-visible   ~ .tabs label[for="z-dlr"],
  #z-dca:focus-visible   ~ .tabs label[for="z-dca"],
  #z-ddd:focus-visible   ~ .tabs label[for="z-ddd"],
  #z-hotel:focus-visible ~ .tabs label[for="z-hotel"] { outline:2px solid var(--accent); outline-offset:2px; }
  #z-dlr:checked   ~ .wrap [data-zone]:not([data-zone~="dlr"]):not([data-zone~="shared"]) { display:none; }
  #z-dca:checked   ~ .wrap [data-zone]:not([data-zone~="dca"]):not([data-zone~="shared"]) { display:none; }
  #z-ddd:checked   ~ .wrap [data-zone]:not([data-zone~="ddd"]):not([data-zone~="shared"]) { display:none; }
  #z-hotel:checked ~ .wrap [data-zone]:not([data-zone~="hotel"]) { display:none; }
  .tab-spacer { flex-grow:1; min-width:8px; }
  .tab-safe { color:var(--green); border-color:rgba(46,204,113,.45); background:transparent; }
  .tab-safe:hover { background:var(--greendim); color:var(--green); }
  #safe-only:checked ~ .tabs label[for="safe-only"] { background:var(--green); color:#0e1116; border-color:var(--green); }
  #safe-only:focus-visible ~ .tabs label[for="safe-only"] { outline:2px solid var(--green); outline-offset:2px; }
  #safe-only:checked ~ .wrap .card.borderline { display:none; }
  #safe-only:checked ~ .wrap .dl-map .dot.borderline { display:none; }
  #safe-only:checked ~ .wrap section:has(.grid):not(:has(.card.viable)) { display:none; }
  button.tab { font:inherit; appearance:none; -webkit-appearance:none; }
  .tab-proximity { color:var(--accent); border-color:rgba(109,179,255,.45); background:transparent; }
  .tab-proximity:hover { background:rgba(109,179,255,.10); }
  .tab-proximity:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .tab-proximity.active { background:var(--accent); color:#0e1116; border-color:var(--accent); }
  .tab-proximity.locating { opacity:.7; cursor:progress; }
  .tab-proximity[disabled] { opacity:.5; cursor:not-allowed; background:transparent; }
  .grid { display:grid; }
  .user-dist { color:var(--accent); font-weight:600; }
  input.tab-search { width:180px; max-width:100%; color:var(--ink); background:var(--panel); border:1px solid var(--line);
    font:inherit; font-size:.85rem; padding:7px 13px; border-radius:999px; appearance:none; -webkit-appearance:none; }
  input.tab-search::placeholder { color:var(--muted); }
  input.tab-search::-webkit-search-cancel-button { -webkit-appearance:none; appearance:none; }
  input.tab-search:focus { outline:2px solid var(--accent); outline-offset:2px; }
  .card.search-hidden { display:none; }
  body.text-filtering .wrap section:has(.grid):not(:has(.card:not(.search-hidden))) { display:none; }
  body.text-filtering .map-section,
  body.text-filtering .howto,
  body.text-filtering .hotel-section .map-wrap,
  body.text-filtering .hotel-section .hotel-intro { display:none; }
  .tab-foodtype { color:#ffd089; border-color:rgba(255,208,137,.45); background:transparent; }
  .tab-foodtype:hover { background:rgba(255,208,137,.10); }
  #ft-breakfast:checked ~ .tabs label[for="ft-breakfast"] { background:#ffd089; color:#0e1116; border-color:#ffd089; }
  #ft-breakfast:focus-visible ~ .tabs label[for="ft-breakfast"] { outline:2px solid #ffd089; outline-offset:2px; }
  #ft-breakfast:checked ~ .wrap .card:not([data-food-types~="breakfast"]) { display:none; }
  #ft-breakfast:checked ~ .wrap section:has(.grid):not(:has(.card[data-food-types~="breakfast"])) { display:none; }
  #ft-breakfast:checked ~ .wrap .howto,
  #ft-breakfast:checked ~ .wrap .hotel-section .map-wrap,
  #ft-breakfast:checked ~ .wrap .hotel-section .hotel-intro { display:none; }
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding-bottom:0">
    <h1>🏰 Disneyland Food Guide</h1>
    <p>Personalized for ${esc(name)} — ${esc(sub)}.</p>
    <p>${nViable} safe bets and ${nBorder} workable-with-care spots across the parks &amp; Downtown Disney, plus ${nHotelViable}+${nHotelBorder} more within 5&thinsp;mi of ${esc(hotel.name)}.</p>
    <div class="legend">
      <span><span class="pill g">🟢 Safe bet</span> a clean order exists</span>
      <span><span class="pill y">🟡 With care</span> only works heavily modified / ask a chef</span>
    </div>
  </div>
</header>
<input type="radio" id="z-all" name="zone" class="zone-toggle" checked>
<input type="radio" id="z-dlr" name="zone" class="zone-toggle">
<input type="radio" id="z-dca" name="zone" class="zone-toggle">
<input type="radio" id="z-ddd" name="zone" class="zone-toggle">
<input type="radio" id="z-hotel" name="zone" class="zone-toggle">
<input type="checkbox" id="safe-only" class="zone-toggle">
<input type="checkbox" id="ft-breakfast" class="zone-toggle">
<nav class="tabs" aria-label="Filter by zone">
  <label for="z-all"     class="tab">All</label>
  <label for="z-dlr"     class="tab">Disneyland Park</label>
  <label for="z-dca"     class="tab">DCA</label>
  <label for="z-ddd"     class="tab">Downtown Disney</label>
  <label for="z-hotel"   class="tab">Around the Hotel</label>
  <label for="ft-breakfast" class="tab tab-foodtype">🍳 Breakfast</label>
  <span class="tab-spacer"></span>
  <input type="search" id="text-filter" class="tab tab-search" placeholder="Search…" aria-label="Search restaurants by text">
  <button type="button" id="sort-proximity" class="tab tab-proximity">📍 Nearest first</button>
  <label for="safe-only" class="tab tab-safe">🟢 Safe bets only</label>
</nav>
<div class="wrap">

  <section class="map-section" data-zone="shared">
    <h2>Map <span class="count">tap a dot to jump to the card</span></h2>
    <div class="map-wrap">
      ${mapSvg}
    </div>
  </section>

  <div class="howto" data-zone="shared">
    <h2>Before you order — every time</h2>
${howtoHtml}
  </div>

  ${body}

  ${hotelSection}

  <footer>
    <p>Built from menu reviews against ${esc(name)}'s dietary file${today ? ` on ${esc(today)}` : ''}. Menus and locations change — always reconfirm with the kitchen on the day. Skipped spots (snack carts, churros, ramen, charcuterie, alcohol-only, etc.) are intentionally not listed.</p>${companion}
  </footer>
</div>
</body>
</html>
`;
};
