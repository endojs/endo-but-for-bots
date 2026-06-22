// md.js — a small, SAFE Markdown→DOM renderer for agent replies + the notification modal. Agents format
// their answers in Markdown even unprompted, so render it. SECURITY: this renders LLM/untrusted text, so it
// NEVER sets innerHTML from input — every text run becomes a DOM text node and only a known, safe set of
// elements is created (h3–h5, p, ul/ol/li, pre/code, blockquote, hr, strong/em/del/code/a). Links are
// restricted to http(s)/mailto/relative and get rel="noopener". No images, no raw HTML, no event handlers.

const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#|www\.)/i;

// ── inline: bold / italic / strike / inline-code / [text](url) / bare URLs → text + element nodes ──
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\((?:https?:\/\/|mailto:|\/|#)[^)\s]+\))|((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)'"])/;
const linkEl = (text, href) => {
  const a = document.createElement('a');
  a.textContent = text;
  if (SAFE_HREF.test(href)) { a.href = /^www\./i.test(href) ? `https://${href}` : href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};
const inline = (parent, text) => {
  let s = String(text); let m;
  while ((m = INLINE.exec(s))) {
    if (m.index > 0) parent.appendChild(document.createTextNode(s.slice(0, m.index)));
    const tok = m[0];
    if (m[1]) { const c = document.createElement('code'); c.textContent = tok.slice(1, -1); parent.appendChild(c); }
    else if (m[2]) { const b = document.createElement('strong'); b.textContent = tok.slice(2, -2); parent.appendChild(b); }
    else if (m[3]) { const i = document.createElement('em'); i.textContent = tok.slice(1, -1); parent.appendChild(i); }
    else if (m[4]) { const d = document.createElement('del'); d.textContent = tok.slice(2, -2); parent.appendChild(d); }
    else if (m[5]) { const mm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/); parent.appendChild(linkEl(mm[1], mm[2])); }
    else if (m[6]) { let url = tok, trail = ''; while (/[.,;:!?)'"]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); } parent.appendChild(linkEl(url, url)); if (trail) parent.appendChild(document.createTextNode(trail)); }
    s = s.slice(m.index + tok.length);
  }
  if (s) parent.appendChild(document.createTextNode(s));
  return parent;
};

// ── block: split into paragraphs / headings / lists / fenced code / blockquote / hr ──
export const renderMarkdown = (el, text) => {
  el.textContent = '';
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const flushList = ordered => {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    while (i < lines.length) {
      const m = lines[i].match(ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/);
      if (!m) break;
      const li = document.createElement('li'); inline(li, m[1]); list.appendChild(li); i += 1;
    }
    el.appendChild(list);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    let m;
    if ((m = line.match(/^```(.*)$/))) { // fenced code block — content is literal (textContent), never parsed
      i += 1; const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1; // closing fence
      const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = buf.join('\n'); pre.appendChild(code); el.appendChild(pre); continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { const lvl = Math.min(5, Math.max(3, m[1].length + 2)); const h = document.createElement(`h${lvl}`); inline(h, m[2]); el.appendChild(h); i += 1; continue; }
    if (/^\s*>\s?/.test(line)) { const bq = document.createElement('blockquote'); const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; } inline(bq, buf.join('\n')); el.appendChild(bq); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { el.appendChild(document.createElement('hr')); i += 1; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { flushList(false); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { flushList(true); continue; }
    // paragraph: gather consecutive non-blank, non-block lines
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>\s?|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
    const p = document.createElement('p'); inline(p, buf.join('\n')); el.appendChild(p);
  }
  return el;
};
