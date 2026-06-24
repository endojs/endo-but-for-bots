// fs-folder.mjs — a plain-node folder cap implementing the SAME async interface as voice-agent's
// makeHomeFolder ({ list, read, write, mkdir }) with the same within(root) path-guard, but WITHOUT harden,
// so the store + importer are headless-testable in plain node. In grunt.mjs (SES, Slice 8) the store is
// instead backed by the real makeHomeFolder cap (confined + publishSite/downloadLink) — same interface.
import fs from 'node:fs';
import path from 'node:path';

const within = (root, rel) => {
  const p = path.resolve(root, String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`path escapes folder root: ${rel}`);
  return p;
};

export const makeFsFolder = root => {
  const abs = path.resolve(root);
  fs.mkdirSync(abs, { recursive: true });
  return {
    root: abs,
    list: async (rel = '') => {
      try {
        const ents = fs.readdirSync(within(abs, rel), { withFileTypes: true });
        return { ok: true, path: rel || '', entries: ents.map(e => ({ name: e.name, dir: e.isDirectory() })) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    read: async rel => { try { return { ok: true, content: fs.readFileSync(within(abs, rel), 'utf8') }; } catch (e) { return { ok: false, error: e.message }; } },
    write: async (rel, content) => {
      try { const p = within(abs, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(content ?? '')); return { ok: true, path: rel }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    mkdir: async rel => { try { fs.mkdirSync(within(abs, rel), { recursive: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
  };
};
