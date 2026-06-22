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

// makeHomeFolder({ root, label, publish, download, ro }) → Far home object.
//   publish(absDir, name)  → { name, url, token }  (injected; registers a static site)
//   download(absFile, name) → { name, url, token }  (injected; registers a download web-key)
export const makeHomeFolder = ({ root, label = 'home', publish, download, ro = false }) => {
  fs.mkdirSync(root, { recursive: true });
  // downloadLink(rel) → a web-key URL that serves THIS file as a download. A read authority (available on
  // read-only homes too). Symlink-safe: the file must canonically resolve to inside this home folder, so an
  // agent can't link out to a host file via a symlink it planted in its own sandbox.
  const downloadLink = async (rel, name) => {
    if (typeof download !== 'function') throw new Error('downloads are not available here');
    const abs = within(root, rel);
    const st = fs.statSync(abs); // throws if missing
    if (!st.isFile()) throw new Error('can only make a download link for a file');
    const real = fs.realpathSync(abs); const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('file resolves outside your home folder');
    return harden(await download(real, name || path.basename(abs)));
  };
  const base = {
    help: () => `Your ${ro ? 'READ-ONLY ' : ''}home folder "${label}". list(path?)/read(path)/downloadLink(path,name?)${ro ? '' : '/write(path,content)/mkdir(path)/remove(path)/publishSite(path,name)'}/readOnly(). Confined to this folder.`,
    describe: () => harden({ kind: 'home', label, readOnly: !!ro }),
    list: async (rel = '') => {
      const p = within(root, rel);
      let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return harden({ ok: false, error: e.message }); }
      return harden({ ok: true, path: rel || '', entries: ents.map(e => ({ name: e.name, dir: e.isDirectory() })) });
    },
    read: async rel => { try { return harden({ ok: true, content: fs.readFileSync(within(root, rel), 'utf8').slice(0, 200000) }); } catch (e) { return harden({ ok: false, error: e.message }); } },
    downloadLink,
    readOnly: () => makeHomeFolder({ root, label, publish, download, ro: true }),
    // share(rel) → a READ-ONLY attenuated view of a sub-path: a directory becomes a read-only
    // home rooted at it (its subtree only); a single file becomes a home exposing ONLY that file.
    // The basis for granular "share one folder/file" capabilities. Throws if rel is outside/missing.
    share: rel => {
      const abs = within(root, rel);
      const st = fs.statSync(abs); // throws if missing
      if (st.isDirectory()) return makeHomeFolder({ root: abs, label: String(rel || label), publish, download, ro: true });
      const fname = path.basename(abs);
      return Far(`HomeFile(${fname})·ro`, {
        help: () => `read-only file "${fname}". list()/read()/downloadLink(). Confined to this one file.`,
        describe: () => harden({ kind: 'home', label: fname, readOnly: true }),
        list: async () => harden({ ok: true, path: '', entries: [{ name: fname, dir: false }] }),
        read: async r => { if (r && path.basename(String(r)) !== fname) return harden({ ok: false, error: 'not in this share' }); try { return harden({ ok: true, content: fs.readFileSync(abs, 'utf8').slice(0, 200000) }); } catch (e) { return harden({ ok: false, error: e.message }); } },
        downloadLink: async () => { if (typeof download !== 'function') throw new Error('downloads are not available here'); return harden(await download(fs.realpathSync(abs), fname)); },
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
