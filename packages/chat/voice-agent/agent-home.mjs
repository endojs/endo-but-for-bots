// agent-home.mjs — a VIRTUAL HOME FOLDER as an object capability. Every agent
// (the entry agent, a delegate, a share-holder) gets one: a writable sandbox
// directory it can read/write/list, and PUBLISH a sub-folder from as a static
// site, receiving the URL back. Holding the home object IS the file authority —
// it is confined to its root dir (path-guarded), and `readOnly()` attenuates.
//
// "Pass our site-publishing capability to a sub-delegate" = hand it a home folder
// (its own sub-dir) whose publishSite() is wired to the same static host. The
// delegate writes its site into its home and publishes it — no ambient fs access.
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import { Far } from '@endo/marshal';

const within = (root, rel) => {
  const p = path.resolve(root, String(rel || '').replace(/^\/+/, ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('path escapes your home folder');
  return p;
};

// makeHomeFolder({ root, label, publish, ro }) → Far home object.
//   publish(absDir, name) → { name, url, token }  (injected; registers a static site)
export const makeHomeFolder = ({ root, label = 'home', publish, ro = false }) => {
  fs.mkdirSync(root, { recursive: true });
  const base = {
    help: () => `Your ${ro ? 'READ-ONLY ' : ''}home folder "${label}". list(path?)/read(path)${ro ? '' : '/write(path,content)/mkdir(path)/remove(path)/publishSite(path,name)'}/readOnly(). Confined to this folder.`,
    describe: () => harden({ kind: 'home', label, readOnly: !!ro }),
    list: async (rel = '') => {
      const p = within(root, rel);
      let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return harden({ ok: false, error: e.message }); }
      return harden({ ok: true, path: rel || '', entries: ents.map(e => ({ name: e.name, dir: e.isDirectory() })) });
    },
    read: async rel => { try { return harden({ ok: true, content: fs.readFileSync(within(root, rel), 'utf8').slice(0, 200000) }); } catch (e) { return harden({ ok: false, error: e.message }); } },
    readOnly: () => makeHomeFolder({ root, label, publish, ro: true }),
    // share(rel) → a READ-ONLY attenuated view of a sub-path: a directory becomes a read-only
    // home rooted at it (its subtree only); a single file becomes a home exposing ONLY that file.
    // The basis for granular "share one folder/file" capabilities. Throws if rel is outside/missing.
    share: rel => {
      const abs = within(root, rel);
      const st = fs.statSync(abs); // throws if missing
      if (st.isDirectory()) return makeHomeFolder({ root: abs, label: String(rel || label), publish, ro: true });
      const fname = path.basename(abs);
      return Far(`HomeFile(${fname})·ro`, {
        help: () => `read-only file "${fname}". list()/read(). Confined to this one file.`,
        describe: () => harden({ kind: 'home', label: fname, readOnly: true }),
        list: async () => harden({ ok: true, path: '', entries: [{ name: fname, dir: false }] }),
        read: async r => { if (r && path.basename(String(r)) !== fname) return harden({ ok: false, error: 'not in this share' }); try { return harden({ ok: true, content: fs.readFileSync(abs, 'utf8').slice(0, 200000) }); } catch (e) { return harden({ ok: false, error: e.message }); } },
        readOnly() { return this; },
      });
    },
  };
  if (!ro) {
    base.write = async (rel, content) => { try { const p = within(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(content ?? '')); return harden({ ok: true, path: rel, bytes: Buffer.byteLength(String(content ?? '')) }); } catch (e) { return harden({ ok: false, error: e.message }); } };
    base.mkdir = async rel => { try { fs.mkdirSync(within(root, rel), { recursive: true }); return harden({ ok: true }); } catch (e) { return harden({ ok: false, error: e.message }); } };
    base.remove = async rel => { try { const p = within(root, rel); if (p === root) throw new Error('refusing to remove the home root'); fs.rmSync(p, { recursive: true, force: true }); return harden({ ok: true }); } catch (e) { return harden({ ok: false, error: e.message }); } };
    // Publish a sub-folder as a static site and get its URL back. The folder must
    // exist (and usually hold an index.html). publish() registers it with the host.
    base.publishSite = async (rel, name) => {
      const dir = within(root, rel || '');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('no such folder to publish');
      return harden(await publish(dir, name || label));
    };
  }
  return Far(`Home(${label})${ro ? '·ro' : ''}`, base);
};
harden(makeHomeFolder);
