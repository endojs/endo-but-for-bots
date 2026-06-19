// Shared vault cross-link resolver. Builds an index of top-level *.md note
// basenames (the entity/topic note space) and conservatively links extracted
// entities to notes that ALREADY exist (exact, case-insensitive match) — so a
// capture becomes "aware of key terms in the Obsidian db".

import fsp from 'node:fs/promises';

// Map<lowercased basename, actual basename> for top-level .md notes under root.
export const makeLinkIndex = async root => {
  const idx = new Map();
  let names = [];
  try { names = await fsp.readdir(root); } catch { return idx; }
  for (const n of names) if (n.endsWith('.md')) idx.set(n.slice(0, -3).toLowerCase(), n.slice(0, -3));
  return idx;
};

// Returns { links: [existing-note-basenames], missing: [unmatched-entities] }.
export const resolveLinks = (idx, entities, selfBase = '', cap = 15) => {
  const out = [];
  const missing = [];
  for (const e of entities || []) {
    const hit = idx.get(String(e).toLowerCase());
    if (hit && hit.toLowerCase() !== String(selfBase).toLowerCase()) out.push(hit);
    else if (!hit) missing.push(e);
  }
  return { links: [...new Set(out)].slice(0, cap), missing: [...new Set(missing)].slice(0, cap) };
};
