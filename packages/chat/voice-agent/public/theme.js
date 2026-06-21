// theme.js — the user's global STYLE as a read-only PROPAGATOR passed down the component hierarchy.
//
// A theme is just an object: { name, mode:'dark'|'light', vars:{ '--x': value } }. The host page FOLLOWS
// the `theme` grain and applies `vars` as CSS custom properties on :root; confined widgets receive the
// same vars over their port and apply them too — so EVERYTHING matches the user's chosen style. This is
// the seed of a consistent, userspace-extensible UI framework: widen `vars` (color schemes, fonts, sizes,
// paddings) and every component inherits it with NO component change, because they all read var(--x).
//
// Components only ever SUBSCRIBE (read-only); the user (or an accepted agent proposal) is the sole writer.

const mkGrain = initial => {
  let v = initial; const subs = new Set();
  return {
    get: () => v,
    set: nv => { v = nv; for (const f of [...subs]) { try { f(v); } catch { /* */ } } },
    subscribe: f => { subs.add(f); if (v !== undefined) { try { f(v); } catch { /* */ } } return () => subs.delete(f); },
  };
};

// MVP presets — dark (current default) + light. The full set of vars the app already themes off.
const DARK = { name: 'dark', mode: 'dark', vars: { '--bg': '#0d1117', '--panel': '#161b22', '--edge': '#30363d', '--ink': '#e6edf3', '--mut': '#8b949e', '--acc': '#7c5cff', '--acc2': '#2ea043', '--bad': '#f85149', '--you': '#1f6feb' } };
const LIGHT = { name: 'light', mode: 'light', vars: { '--bg': '#ffffff', '--panel': '#f3f5f8', '--edge': '#d0d7de', '--ink': '#1f2328', '--mut': '#636c76', '--acc': '#7c5cff', '--acc2': '#1a7f37', '--bad': '#cf222e', '--you': '#0969da' } };
export const BUILTINS = { dark: DARK, light: LIGHT };
export const theme = mkGrain(DARK); // THE propagator — read-only to components.
const KEY = 'field-agent-theme';

export const applyVars = (root, vars) => { if (!root || !vars) return; for (const k in vars) { try { root.style.setProperty(k, vars[k]); } catch { /* */ } } };
// infer dark/light from the bg luminance, so an agent-authored theme that omits `mode` still sets color-scheme right.
export const inferMode = vars => { const c = String((vars && vars['--bg']) || '#000').replace('#', ''); const n = c.length >= 6 ? c : '000000'; const lum = (parseInt(n.slice(0, 2), 16) + parseInt(n.slice(2, 4), 16) + parseInt(n.slice(4, 6), 16)) / 3; return lum > 140 ? 'light' : 'dark'; };

// apply ANY theme object (built-in or agent-authored) globally + persist the FULL object so a custom theme survives reload.
export const applyTheme = t => { const obj = (t && t.vars) ? { name: t.name || 'custom', mode: t.mode || inferMode(t.vars), vars: t.vars } : DARK; theme.set(obj); try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch { /* */ } return obj; };
export const setTheme = name => applyTheme(BUILTINS[name] || DARK);
export const cycleTheme = () => applyTheme(theme.get().mode === 'light' ? DARK : LIGHT);

// boot: the host page FOLLOWS the propagator → CSS vars + color-scheme on :root; restore the saved theme.
export const initTheme = () => {
  theme.subscribe(t => { applyVars(document.documentElement, t.vars); try { document.documentElement.style.colorScheme = t.mode || 'dark'; } catch { /* */ } });
  let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* */ }
  applyTheme(saved && saved.vars ? saved : DARK);
};
