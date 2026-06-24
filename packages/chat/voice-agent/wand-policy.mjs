// wand-policy.mjs — the HELD AUTHORITY to auto-mint a specialist on a name-miss (the magic wand, Phase 5 of the
// ocap-designate-by-reference plan). The wand is no longer "any name → new authority". To auto-mint, a node must
// HOLD a wand policy (node.wandBinding) that ENUMERATES which specializations may be minted and the CEILING of
// powers each may hold. A node without the policy can't wand; a name matching no entry is a graceful miss; and
// the minted powers are entry.powers ∩ caller (so the policy ceiling AND the caller bound both apply).
//
// (No harden() at module level so this stays importable in plain-node tests; agent-caps hardens what it holds.)

// a tiny glob: '*' matches any run. 'foo*' / '*foo' / '*foo*' / exact 'foo'. case-insensitive.
const globToRe = m => new RegExp(`^${String(m).split('*').map(s => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('.*')}$`, 'i');

// makeWandPolicy(entries) → { match(name) → entry|null, list() }. entry = { match, powers[], domain, instructions }.
export const makeWandPolicy = (entries = []) => {
  const list = (Array.isArray(entries) ? entries : [])
    .map(e => ({ match: String((e && e.match) || ''), powers: Array.isArray(e && e.powers) ? e.powers.map(String) : [], domain: String((e && e.domain) || ''), instructions: String((e && e.instructions) || '') }))
    .filter(e => e.match);
  const res = list.map(e => ({ ...e, re: globToRe(e.match) }));
  return {
    match: name => res.find(e => e.re.test(String(name || ''))) || null,
    list: () => list.map(e => ({ match: e.match, powers: e.powers })),
  };
};

// A conservative default so the wand works out of the box but ONLY for low-authority, read-leaning helpers.
// Override by dropping a {"entries":[…]} file at ~/.config/field-agent/wand-policy.json. Powers here are a
// CEILING — the minted specialist still gets only what the CALLER also holds.
export const DEFAULT_WAND_POLICY = [
  { match: '*research*', powers: ['notes.dietician', 'notes', 'web', 'reference'], domain: 'focused research', instructions: 'You are a focused research specialist. Investigate the request using your notes + the web, cite sources, and report concisely. Do not act outside reading + reporting.' },
  { match: '*plan*', powers: ['notes', 'web'], domain: 'planning', instructions: 'You are a planning specialist. Break the request into a clear, ordered plan with concrete next steps; do not execute it.' },
  { match: '*writ*', powers: ['notes'], domain: 'writing', instructions: 'You are a writing specialist. Draft clear, concise prose for the request from the given material.' },
  { match: '*summar*', powers: ['notes'], domain: 'summarization', instructions: 'You are a summarization specialist. Produce a faithful, concise summary of the supplied material.' },
];
