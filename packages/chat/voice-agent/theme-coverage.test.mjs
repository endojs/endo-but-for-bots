// theme-coverage.test.mjs — the cheap, deterministic half of the theme-matrix check (no browser).
//   node --test packages/chat/voice-agent/theme-coverage.test.mjs
//
// Encodes the three invariants the light-mode bug exposed:
//   1. every built-in theme defines the SAME full var set (so light/dark stay in lockstep AND an OLD
//      persisted theme can backfill from the same-mode built-in — the exact "user bubble dark in light
//      mode" failure was a var present in dark/:root but absent from the saved light theme);
//   2. :root carries a fallback value for every theme var (readable first paint before JS applies a theme);
//   3. every var(--x) referenced in the CSS/JS is a real theme var (or a known component-local var) — a typo
//      or a var added to code but not to the palettes would silently fall back to nothing.
// Plus a lint: no NEW opaque hardcoded background may appear on a surface (the root of the bug class was a
// hardcoded dark fill under themed var(--ink) text). Intentional fixed-palette surfaces are allowlisted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTINS } from './public/theme.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');
const styleBlock = () => (read('public/index.html').match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

// vars set imperatively from JS per-element (NOT supplied by a theme) — legitimately absent from BUILTINS.
const LOCAL_VARS = new Set(['--orb-lvl', '--x']);

test('every built-in theme defines the SAME full set of vars (light/dark lockstep + backfill invariant)', () => {
  const names = Object.keys(BUILTINS);
  const keysOf = n => new Set(Object.keys(BUILTINS[n].vars));
  const union = new Set(names.flatMap(n => [...keysOf(n)]));
  for (const n of names) {
    const have = keysOf(n);
    const missing = [...union].filter(k => !have.has(k));
    assert.deepEqual(missing, [], `built-in theme "${n}" is missing var(s): ${missing.join(', ')} — add them so an old persisted theme backfills and the modes stay in lockstep`);
  }
});

test(':root defines a fallback for every theme var (readable first paint before JS runs)', () => {
  const root = (styleBlock().match(/:root\s*\{([^}]*)\}/) || [, ''])[1];
  const rootVars = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const missing = Object.keys(BUILTINS.dark.vars).filter(v => !rootVars.has(v));
  assert.deepEqual(missing, [], `:root is missing fallback values for: ${missing.join(', ')}`);
});

test('every var(--x) referenced in CSS/JS is a defined theme var (or a known component-local var)', () => {
  const themeVars = new Set(Object.keys(BUILTINS.dark.vars));
  const files = ['public/index.html', 'public/app.js', 'public/theme.js',
    ...fs.readdirSync(path.join(HERE, 'client')).filter(f => f.endsWith('.js')).map(f => `client/${f}`)];
  const offenders = [];
  for (const f of files) {
    let src; try { src = read(f); } catch { continue; }
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      const v = m[1];
      if (!themeVars.has(v) && !LOCAL_VARS.has(v)) offenders.push(`${f} → ${v}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], `undefined theme var(s) referenced (add to a palette in theme.js, or to LOCAL_VARS if set imperatively): ${[...new Set(offenders)].join('; ')}`);
});

// ── lint: a surface background must be themed (a var / translucent tint), not an opaque hardcoded color.
// The reported bug was exactly this: opaque dark fills (#0f1830 / #0d1117 / #0f2018 / #1c2433 …) under
// themed var(--ink) text went dark-on-dark in light mode. Genuinely fixed-palette surfaces are allowlisted
// WITH a reason; anything else opaque + hardcoded fails until it's themed or consciously allowlisted.
const ALLOW = [
  ['.qrcard', 'QR codes require a white quiet-zone; the card is intentionally white in both modes'],
  ['#qrmodal textarea', 'deliberately-white reveal field on the dark consent sheet (self-consistent #fff/#111)'],
  ['.codeview', 'fixed-palette code/terminal block (light text on near-black, readable in both modes)'],
  ['#trace-overlay', 'fullscreen 3D trace scene — intentionally dark canvas backdrop'],
  ['#trace-app-overlay', 'fullscreen 3D trace-app scene — intentionally dark canvas backdrop'],
  ['#widget-overlay', 'fullscreen widget overlay — intentionally dark canvas backdrop'],
  ['#pendant-wrap.fs', 'fullscreen 3D pendant scene — intentionally dark canvas backdrop'],
  ['.mini', 'control buttons sitting ON the dark 3D overlays above (dark context)'],
  ['.kit-toggle-thumb', 'the movable toggle knob is a white disc in both modes (no text)'],
  ['.kit-tip-pop', 'tooltip popover is intentionally dark (#000/#fff) in both modes (common pattern)'],
];
const opaqueHardcoded = value => {
  // a background value is an offender if it contains an OPAQUE hardcoded color (hex w/o alpha, rgb(), or
  // #rrggbbaa==ff). Translucent tints (#rrggbbaa<ff, rgba(...,<1)) layer over a themed surface → fine.
  // Decorative multi-stop gradients (brand orbs/badges) are intentional fixed fills; only the "fade to an
  // opaque background" gradient pattern (which includes `transparent`, like the old composer fade) is a bug.
  if (/gradient\(/.test(value) && !/transparent/.test(value)) return false;
  for (const hex of value.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const h = hex[1];
    if (h.length === 8) { if (h.slice(6).toLowerCase() === 'ff') return true; continue; } // 8-hex: opaque only if alpha ff
    return true; // 3- or 6-digit hex is opaque
  }
  for (const fn of value.matchAll(/rgba?\(([^)]*)\)/g)) {
    const parts = fn[1].split(',').map(s => s.trim());
    const a = parts.length === 4 ? parseFloat(parts[3]) : 1;
    if (a >= 1) return true;
  }
  return false;
};
test('no surface uses an opaque hardcoded background (themed-text-on-stuck-dark is the bug class)', () => {
  const css = styleBlock();
  const offenders = [];
  for (const line of css.split('\n')) {
    const decl = line.match(/(background(?:-color)?)\s*:\s*([^;]+)/);
    if (!decl) continue;
    const value = decl[2];
    if (!opaqueHardcoded(value)) continue;
    const selector = (line.split('{')[0] || '').trim() || '(continuation line)';
    if (ALLOW.some(([sel]) => selector.includes(sel))) continue;
    offenders.push(`${selector} → ${decl[1]}:${value.trim()}`);
  }
  assert.deepEqual(offenders, [], `opaque hardcoded background(s) found — point them at a theme var (var(--bg)/var(--panel)/…) or, if a deliberately fixed-palette surface, add to ALLOW with a reason:\n  ${offenders.join('\n  ')}`);
});
