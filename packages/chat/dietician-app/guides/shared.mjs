// guides/shared.mjs — the helpers BOTH guide generators share (the persona duplicated these across
// eats-guide/gen_guide.py and disneyland-food-guide/gen_guide.py): HTML escaping, city/address parsing, the
// Google Maps link (real place_id vs synthetic Disney id), the dish list item, and the restaurant CARD.
// Ported 1:1. Plain node (no Endo/harden).

// html.escape(s) default — escapes & < > " '
export const esc = s => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// city from an address like '123 Main St, Cityname, CA 90001, USA'
export const cityOf = addr => { const m = /,\s*([^,]+),\s*[A-Z]{2}\s+\d/.exec(addr || ''); return m ? m[1].trim() : 'Other'; };
export const citySlug = city => String(city).toLowerCase().replace(/ /g, '-');

// real Google place ids (ChIJ/Gho/Eh) → a place link; synthetic ids (hand-authored Disney) → a name+addr search
export const mapsUrl = r => {
  const pid = (r.place_id || '').trim();
  if (pid.startsWith('ChIJ') || pid.startsWith('Gho') || pid.startsWith('Eh')) return `https://www.google.com/maps/place/?q=place_id:${pid}`;
  const q = encodeURIComponent(`${r.name || ''}${r.address || ''}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
};

export const dishHtml = dish => {
  const d = typeof dish === 'string' ? { name: dish } : dish;
  const parts = [`<span class="dish-name">${esc(d.name || '')}</span>`];
  if (d.modifications) parts.push(`<span class="mod">${esc(d.modifications)}</span>`);
  if (d.residual_risk) parts.push(`<span class="risk">Residual risk: ${esc(d.residual_risk)}</span>`);
  return '<li class="dish">' + parts.join('') + '</li>';
};

const cardAttrs = (r, cls) => {
  let attrs = `class="card ${cls}" id="card-${esc(r.slug || '')}"`;
  if (r.lat != null && r.lng != null) attrs += ` data-lat="${r.lat}" data-lng="${r.lng}"`;
  const ft = r.food_types || [];
  if (ft.length) attrs += ` data-food-types="${esc(ft.join(' '))}"`;
  return attrs;
};

// the restaurant card. `extraMeta` (e.g. a Disney "X mi from hotel" pill) is appended to the meta line.
export const card = (r, { extraMeta = [] } = {}) => {
  const cls = r.verdict === 'VIABLE' ? 'viable' : 'borderline';
  const badge = r.verdict === 'VIABLE' ? '🟢 Safe bet' : '🟡 With care';
  const bits = [`<article ${cardAttrs(r, cls)}>`, '<div class="card-head">',
    `<h3><a class="card-link" href="${esc(mapsUrl(r))}" target="_blank" rel="noopener noreferrer">${esc(r.name || '')}</a></h3>`,
    `<span class="badge ${cls}">${badge}</span>`, '</div>'];
  const meta = [];
  if (r.primary_type) meta.push(esc(r.primary_type));
  if (r.cuisine) meta.push(esc(r.cuisine));
  if (r.city) meta.push(esc(r.city));
  for (const m of extraMeta) meta.push(m);
  if (meta.length) bits.push('<p class="meta">' + meta.join(' · ') + '</p>');
  if (r.summary) bits.push(`<p class="summary">${esc(r.summary)}</p>`);
  const dishes = r.promising_dishes || [];
  if (dishes.length) { bits.push('<p class="label">Order this</p><ul class="dishes">'); for (const d of dishes) bits.push(dishHtml(d)); bits.push('</ul>'); }
  if (r.avoid_outright && r.avoid_outright.length) bits.push('<p class="label">Avoid here</p><p class="avoid">' + esc(r.avoid_outright.join(', ')) + '</p>');
  if (r.kitchen_flexibility) bits.push(`<p class="flex"><strong>Kitchen:</strong> ${esc(r.kitchen_flexibility)}</p>`);
  if (r.menu_url) bits.push(`<p class="menu"><a href="${esc(r.menu_url)}" rel="noopener noreferrer">View current menu →</a></p>`);
  bits.push('</article>');
  return bits.join('\n');
};

export const personName = person => (person ? person.charAt(0).toUpperCase() + person.slice(1) : 'the diner');
