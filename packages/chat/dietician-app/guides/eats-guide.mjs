// guides/eats-guide.mjs — the city-grouped Eats Guide, ported from eats-guide/gen_guide.py. Takes the flat
// merged rows (place + this-person's verdict, VIABLE/BORDERLINE, non-Disney), groups by city, sorts each
// (VIABLE first, then name), orders cities by count, and renders one self-contained dark-theme HTML page
// (inline CSS; the only external asset is sort.js — the shared client script). Parameterized by person.
import { esc, citySlug, card, personName } from './shared.mjs';

export const generateEatsGuide = (rows, { person = 'alexa', today = '', tagline } = {}) => {
  const name = personName(person);
  const order = { VIABLE: 0, BORDERLINE: 1 };

  const byCity = {};
  for (const r of rows) (byCity[r.city] = byCity[r.city] || []).push(r);
  for (const c of Object.keys(byCity)) {
    byCity[c].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9)
      || (String(a.name || '') < String(b.name || '') ? -1 : String(a.name || '') > String(b.name || '') ? 1 : 0));
  }
  const sortedCities = Object.keys(byCity).sort((a, b) => byCity[b].length - byCity[a].length);
  const nViable = rows.filter(r => r.verdict === 'VIABLE').length;
  const nBorder = rows.filter(r => r.verdict === 'BORDERLINE').length;

  const tabsHtml = sortedCities.map(city =>
    `<button type="button" class="tab city-tab" data-zone="${esc(citySlug(city))}">${esc(city)} <span class="tab-count">${byCity[city].length}</span></button>`).join('\n  ');

  const sections = [];
  for (const city of sortedCities) {
    const items = byCity[city];
    const nv = items.filter(r => r.verdict === 'VIABLE').length;
    const nb = items.length - nv;
    sections.push(`<section data-zone="${esc(citySlug(city))}"><h2>${esc(city)} <span class="count">${nv} safe · ${nb} with care</span></h2>`);
    sections.push('<div class="grid">');
    for (const r of items) sections.push(card(r));
    sections.push('</div></section>');
  }
  const body = sections.join('\n');
  const sub = tagline || 'your dietary constraints — gluten-free, low-histamine / low-FODMAP';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Eats Guide — for ${esc(name)}</title>
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
  header { padding:28px 20px 18px; background:linear-gradient(160deg,#1b2330,#10141b);
    border-bottom:1px solid var(--line); }
  header h1 { margin:0 0 6px; font-size:1.5rem; }
  header p { margin:4px 0; color:var(--muted); font-size:.95rem; }
  .wrap { max-width:920px; margin:0 auto; padding:0 16px 64px; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 0; font-size:.85rem; color:var(--muted); }
  .pill { padding:2px 10px; border-radius:999px; font-weight:600; }
  .pill.g { background:var(--greendim); color:var(--green); }
  .pill.y { background:var(--yellowdim); color:var(--yellow); }
  section { margin:30px 0 0; }
  section > h2 { font-size:1.2rem; border-bottom:1px solid var(--line); padding-bottom:8px;
    display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .count { font-size:.78rem; color:var(--muted); font-weight:400; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; margin-top:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-left-width:4px;
    border-radius:12px; padding:14px 16px; }
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
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line);
    color:var(--muted); font-size:.8rem; }
  .card:target { box-shadow:0 0 0 2px var(--accent), 0 0 14px rgba(109,179,255,.35); }
  .card h3 a.card-link { color:inherit; text-decoration:none;
    border-bottom:1px dashed rgba(109,179,255,.45); }
  .card h3 a.card-link:hover,
  .card h3 a.card-link:focus { color:var(--accent); border-bottom-color:var(--accent); }
  .card h3 a.card-link:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }
  .tabs { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:6px;
    max-width:920px; margin:0 auto; padding:10px 16px;
    background:rgba(14,17,22,.92); backdrop-filter:saturate(160%) blur(6px);
    border-bottom:1px solid var(--line); }
  .tab { padding:7px 13px; border-radius:999px; cursor:pointer;
    background:var(--panel); border:1px solid var(--line); color:var(--muted);
    font-size:.85rem; font-weight:600; user-select:none; line-height:1;
    transition:background .12s ease, color .12s ease, border-color .12s ease; }
  .tab:hover { background:var(--panel2); color:var(--ink); }
  .tab.active { background:var(--accent); color:#0e1116; border-color:var(--accent); }
  .tab-count { font-weight:400; opacity:.7; font-size:.8em; }
  .tab-spacer { flex-grow:1; min-width:8px; }
  .tab-safe { color:var(--green); border-color:rgba(46,204,113,.45); background:transparent; }
  .tab-safe:hover { background:var(--greendim); color:var(--green); }
  .tab-safe.active { background:var(--green); color:#0e1116; border-color:var(--green); }
  body.safe-only .card.borderline { display:none; }
  body.safe-only section:has(.grid):not(:has(.card.viable)) { display:none; }
  button.tab { font:inherit; appearance:none; -webkit-appearance:none; }
  .tab-proximity { color:var(--accent); border-color:rgba(109,179,255,.45); background:transparent; }
  .tab-proximity:hover { background:rgba(109,179,255,.10); }
  .tab-proximity:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .tab-proximity.active { background:var(--accent); color:#0e1116; border-color:var(--accent); }
  .tab-proximity.locating { opacity:.7; cursor:progress; }
  .tab-proximity[disabled] { opacity:.5; cursor:not-allowed; background:transparent; }
  .user-dist { color:var(--accent); font-weight:600; }
  input.tab-search { width:180px; max-width:100%; color:var(--ink);
    background:var(--panel); border:1px solid var(--line);
    font:inherit; font-size:.85rem; padding:7px 13px; border-radius:999px;
    appearance:none; -webkit-appearance:none; }
  input.tab-search::placeholder { color:var(--muted); }
  input.tab-search::-webkit-search-cancel-button { -webkit-appearance:none; appearance:none; }
  input.tab-search:focus { outline:2px solid var(--accent); outline-offset:2px; }
  .card.search-hidden { display:none; }
  body.text-filtering .wrap section:has(.grid):not(:has(.card:not(.search-hidden))) { display:none; }
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding-bottom:0">
    <h1>🍽️ Eats Guide</h1>
    <p>Personalized for ${esc(name)} — ${esc(sub)}.</p>
    <p>${nViable} safe bets and ${nBorder} workable-with-care spots across ${sortedCities.length} cities.</p>
    <div class="legend">
      <span><span class="pill g">🟢 Safe bet</span> a clean order exists</span>
      <span><span class="pill y">🟡 With care</span> only works heavily modified / ask a chef</span>
    </div>
  </div>
</header>
<nav class="tabs" aria-label="Filter by city">
  <button type="button" class="tab city-tab active" data-zone="all">All</button>
  ${tabsHtml}
  <span class="tab-spacer"></span>
  <input type="search" id="text-filter" class="tab tab-search" placeholder="Search…" aria-label="Search restaurants by text">
  <button type="button" id="sort-proximity" class="tab tab-proximity">📍 Nearest first</button>
  <button type="button" id="safe-only-btn" class="tab tab-safe">🟢 Safe bets only</button>
</nav>
<div class="wrap">
  ${body}

  <footer>
    <p>Built from menu reviews against ${esc(name)}'s dietary file${today ? ` on ${esc(today)}` : ''}. Menus and locations change — always reconfirm with the kitchen on the day.</p>
  </footer>
</div>
<script>
(function () {
  var tabs = document.querySelectorAll('.city-tab');
  var sections = document.querySelectorAll('section[data-zone]');
  function activateZone(zone) {
    tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.zone === zone); });
    sections.forEach(function(s) {
      if (zone === 'all') { s.style.display = ''; }
      else { s.style.display = (s.dataset.zone === zone) ? '' : 'none'; }
    });
  }
  tabs.forEach(function(t) { t.addEventListener('click', function() { activateZone(t.dataset.zone); }); });
  var safeBtn = document.getElementById('safe-only-btn');
  if (safeBtn) {
    safeBtn.addEventListener('click', function() {
      var on = document.body.classList.toggle('safe-only');
      safeBtn.classList.toggle('active', on);
    });
  }
})();
</script>
</body>
</html>
`;
};
