#!/usr/bin/env node
// A dependency-free duplicate-block finder for JavaScript (AR-DUP review).
//   node find-duplicates.mjs [--min 8] [--ids] DIR... [-- OTHERDIR...]
// Files become normalised lines: comments removed, whitespace collapsed,
// import/export-from statements and lines with no word character dropped.
// --ids replaces identifiers and literals with placeholders (token mode).
// Windows of --min lines are hashed, equal windows extended to maximal
// blocks, equal blocks grouped into clusters. With `--`, only clusters that
// touch both sets are reported.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
let min = 8;
let ids = false;
const sets = [[]];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--min') min = Number(argv[(i += 1)]);
  else if (argv[i] === '--ids') ids = true;
  else if (argv[i] === '--') sets.push([]);
  else sets[sets.length - 1].push(argv[i]);
}

const walk = dir =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(m?js|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });

const KEYWORDS = new Set(
  `const let var function return if else for while do switch case break
  continue new throw try catch finally async await yield of in typeof
  instanceof class extends default this null undefined true false export
  import harden`.split(/\s+/),
);

// Remove comments, stepping over string and template literals (roughly).
const stripComments = src => {
  let out = '';
  let q = null;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c === '\\' ? c + (n ?? '') : c;
      if (c !== '\\' && c === q) q = null;
      i += c === '\\' ? 2 : 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      if (c === '"' || c === "'" || c === '`') q = c;
      out += c;
      i += 1;
    }
  }
  return out;
};

const normalise = file => {
  const lines = [];
  let inImport = false;
  const raw = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
  raw.forEach((text, idx) => {
    let t = text.trim().replace(/\s+/g, ' ');
    if (/^(import|export)\b.*\bfrom\b|^import ['"]/.test(t)) return;
    if (/^import\b|^export \{$/.test(t)) {
      inImport = true;
      return;
    }
    if (inImport) {
      if (/\bfrom\b|^\};?$/.test(t)) inImport = false;
      return;
    }
    if (!/\w/.test(t)) return;
    if (ids) {
      t = t
        .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, 'S')
        .replace(/\b\d[\d_.xXa-fA-F]*n?\b/g, 'N')
        .replace(/[A-Za-z_$][\w$]*/g, w => (KEYWORDS.has(w) ? w : 'I'));
      // A bare name in a list (`I,` or `I: I,`) matches every parameter list.
      if (/^(\.\.\.)?I(: I)?( = [IN S])?,?$/.test(t)) return;
    }
    lines.push({ t, line: idx + 1 });
  });
  return lines;
};

const setOf = new Map();
sets.forEach((dirs, si) => {
  for (const d of dirs) {
    for (const f of fs.statSync(d).isDirectory() ? walk(d) : [d]) {
      setOf.set(f, si);
    }
  }
});
const norm = new Map([...setOf.keys()].map(f => [f, normalise(f)]));
const textOf = (f, i, n) =>
  norm
    .get(f)
    .slice(i, i + n)
    .map(l => l.t)
    .join('\n');

const windows = new Map();
for (const [f, ls] of norm) {
  for (let i = 0; i + min <= ls.length; i += 1) {
    const key = textOf(f, i, min);
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push([f, i]);
  }
}

const same = (fa, ia, fb, ib) => {
  const a = norm.get(fa)[ia];
  const b = norm.get(fb)[ib];
  return a && b && a.t === b.t;
};

const clusters = new Map();
for (const occ of windows.values()) {
  for (let x = 0; x < occ.length; x += 1) {
    for (let y = x + 1; y < occ.length; y += 1) {
      const [fa, ia] = occ[x];
      const [fb, ib] = occ[y];
      if (fa === fb && Math.abs(ia - ib) < min) continue;
      // Only a maximal block's first window starts a block.
      if (ia > 0 && ib > 0 && same(fa, ia - 1, fb, ib - 1)) continue;
      let n = min;
      while (same(fa, ia + n, fb, ib + n) && !(fa === fb && ia + n === ib)) {
        n += 1;
      }
      const text = textOf(fa, ia, n);
      if (!clusters.has(text)) clusters.set(text, new Map());
      for (const [f, i] of [
        [fa, ia],
        [fb, ib],
      ]) {
        const ls = norm.get(f);
        clusters.get(text).set(`${f}:${ls[i].line}`, {
          file: f,
          from: ls[i].line,
          to: ls[i + n - 1].line,
          set: setOf.get(f),
        });
      }
    }
  }
}

let rows = [...clusters.entries()].map(([text, m]) => {
  const members = [...m.values()];
  const lines = text.split('\n');
  const waste = lines.length * (members.length - 1);
  return { lines: lines.length, members, waste, first: lines[0] };
});
// Drop clusters wholly inside a larger cluster's ranges.
rows.sort((a, b) => b.lines - a.lines);
const covered = [];
rows = rows.filter(r => {
  const inside = r.members.every(mm =>
    covered.some(c => c.file === mm.file && c.from <= mm.from && mm.to <= c.to),
  );
  if (!inside) covered.push(...r.members);
  return !inside;
});
if (sets.length > 1) {
  rows = rows.filter(r => new Set(r.members.map(m => m.set)).size > 1);
}
rows.sort((a, b) => b.waste - a.waste || b.lines - a.lines);

const normLines = [...norm.values()].reduce((s, l) => s + l.length, 0);
const dupLines = new Set();
for (const r of rows) {
  for (const m of r.members) {
    for (const l of norm.get(m.file)) {
      if (l.line >= m.from && l.line <= m.to)
        dupLines.add(`${m.file}:${l.line}`);
    }
  }
}
const mode = ids ? ', token mode' : '';
console.log(
  `files ${norm.size}, normalised lines ${normLines}, lines in a duplicate block ${dupLines.size}, clusters ${rows.length} (min ${min}${mode})`,
);
for (const r of rows) {
  console.log(
    `\n${r.lines} lines x ${r.members.length}: ${r.first.slice(0, 90)}`,
  );
  for (const m of r.members) {
    console.log(`  ${path.relative(process.cwd(), m.file)}:${m.from}-${m.to}`);
  }
}
