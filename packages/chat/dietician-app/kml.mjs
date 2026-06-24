// kml.mjs — build a Google My Maps KML from merged place+verdict records. Ported VERBATIM from the persona's
// build_kml.py. Only VIABLE + BORDERLINE get markers (SKIP/UNKNOWN stay in the DB, off the map). Load-bearing
// fidelity points preserved exactly:
//   • coordinates are LNG,LAT,0  (KML order — NOT lat,lng)
//   • the VIABLE icon tint is ABGR 'ff00aa00' (opaque green), not RGB
//   • the description is <![CDATA[...]]> with inner text escaped like xml.sax.saxutils.escape (& < > ONLY —
//     quotes are NOT escaped, matching the persona; so a menu_url is emitted raw inside href="...")
//   • dish bullets use the &#8226; entity + <small> risk tags
// Parameterized by person (the persona hardcoded "Alexa"). Plain node (no Endo/harden).

// xml.sax.saxutils.escape default: escapes & < > only.
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const VERDICT_EMOJI = { VIABLE: '🟢', BORDERLINE: '🟡' };
const VERDICT_ICON = {
  VIABLE: { href: 'https://maps.google.com/mapfiles/kml/shapes/dining.png', color: 'ff00aa00' },
  BORDERLINE: { href: 'https://maps.google.com/mapfiles/kml/shapes/caution.png', color: null },
};
const FOLDER_NAMES = {
  VIABLE: '🟢 Very Safe (VIABLE) — go here',
  BORDERLINE: '🟡 Questionable (BORDERLINE) — proceed with caution',
};

const styleBlock = () => Object.entries(VERDICT_ICON).map(([verdict, cfg]) => {
  const colorLine = cfg.color ? `        <color>${cfg.color}</color>\n` : '';
  return `    <Style id="${verdict}">
      <IconStyle>
        <scale>1.2</scale>
${colorLine}        <Icon><href>${cfg.href}</href></Icon>
      </IconStyle>
    </Style>`;
}).join('\n');

const placemark = (p, name) => {
  const emoji = VERDICT_EMOJI[p.verdict] || '';
  const nm = esc(emoji ? `${emoji} ${p.name}` : p.name);
  const lines = [`<b>Verdict:</b> ${emoji} ${p.verdict}`];
  if (p.cuisine) lines.push(`<b>Cuisine:</b> ${esc(p.cuisine)}`);
  if (p.address) lines.push(`<b>Address:</b> ${esc(p.address)}`);
  if (p.summary) lines.push(`<br/>${esc(p.summary)}`);
  if (Array.isArray(p.promising_dishes) && p.promising_dishes.length) {
    lines.push(`<br/><b>Promising dishes (${esc(name)}):</b>`);
    for (const d of p.promising_dishes) {
      let line = `&#8226; <i>${esc(d.name)}</i>`;
      if (d.modifications) line += ` — ${esc(d.modifications)}`;
      if (d.residual_risk) line += ` <small>(risk: ${esc(d.residual_risk)})</small>`;
      lines.push(line);
    }
  }
  if (p.menu_url) lines.push(`<br/><a href="${esc(p.menu_url)}">Menu</a>`);
  lines.push(`<br/><small>Evaluated ${esc(p.evaluated_date || '?')} for ${esc(p.evaluated_for || '?')}</small>`);
  const desc = `<![CDATA[${lines.join('<br/>')}]]>`;
  return `    <Placemark>
      <name>${nm}</name>
      <styleUrl>#${p.verdict}</styleUrl>
      <description>${desc}</description>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`;
};

const folderBlock = (verdict, items, name) => `  <Folder>
    <name>${FOLDER_NAMES[verdict]}</name>
    <description>${items.length} place(s). In Google My Maps this is a separate layer — set its icon and color independently.</description>
${items.map(p => placemark(p, name)).join('\n')}
  </Folder>`;

// items = merged place+verdict records. Returns { kml, total, viable, borderline }.
export const buildKml = (items, { person = 'alexa', title } = {}) => {
  const name = person ? person.charAt(0).toUpperCase() + person.slice(1) : 'the diner';
  const docTitle = title || `Safe Eats (${name})`;
  const byVerdict = { VIABLE: [], BORDERLINE: [] };
  for (const p of items || []) {
    if (!(p.verdict in byVerdict)) continue;
    if (p.lat == null || p.lng == null) continue;
    byVerdict[p.verdict].push(p);
  }
  // sort by raw name, code-point order (matches Python's default string sort).
  for (const v of Object.keys(byVerdict)) byVerdict[v].sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
  const folders = ['VIABLE', 'BORDERLINE'].filter(v => byVerdict[v].length).map(v => folderBlock(v, byVerdict[v], name)).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(docTitle)}</name>
  <description>Restaurants evaluated against ${esc(name)}'s dietary constraints. Two layers: VIABLE (go) and BORDERLINE (caution). Skips and unknowns are kept in the local DB but not in this file.</description>
${styleBlock()}
${folders}
</Document>
</kml>
`;
  return { kml, total: byVerdict.VIABLE.length + byVerdict.BORDERLINE.length, viable: byVerdict.VIABLE.length, borderline: byVerdict.BORDERLINE.length };
};
