// island-source.mjs — the confined-Preact ISLANDS as versioned COMPONENTS. An island's source is a
// client file (e.g. client/shares-panel.js), so editing it = rewrite the file + rebuild the islands
// bundle (vite). We version it through the same component-git, so islands get history/revert like any
// component; applying an edit is build-gated and rolls back on failure (the live bundle is never left
// broken). This is what makes the Alt/Option-click overlay light up on the live UI: the rendered island
// carries `data-component-id`, and selecting → edit goes through here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);

// The registered islands (seeded; grows as more UI is componentised). Each: { id, name, files:[client-relative] }.
const ISLANDS = [
  { id: 'island-shares-panel', name: 'Shares panel', file: 'client/shares-panel.js' },
  { id: 'island-notifications', name: 'Notifications', file: 'client/notification-card.js' },
  { id: 'island-changelog', name: 'Changelog', file: 'client/changelog-list.js' },
  { id: 'island-powers-banner', name: 'Powers banner', file: 'client/powers-banner.js' },
  { id: 'island-ask-card', name: 'Ask card', file: 'client/ask-card.js' },
  { id: 'island-proposal-card', name: 'Proposal card', file: 'client/proposal-card.js' },
  { id: 'island-chat-list', name: 'Chat list', file: 'client/chat-list.js' },
  { id: 'island-message-controls', name: 'Message controls', file: 'client/message-controls.js' },
  { id: 'island-chat-meta-bar', name: 'Chat meta bar', file: 'client/chat-meta-bar.js' },
  { id: 'island-dev-task-card', name: 'Dev task card', file: 'client/dev-task-card.js' },
  { id: 'island-exhausted-card', name: 'Out-of-allowance card', file: 'client/exhausted-card.js' },
  { id: 'island-trace-signature', name: 'Trace signature', file: 'client/trace-signature.js' },
  { id: 'island-object-browser', name: 'Object browser', file: 'client/object-browser.js' },
  { id: 'island-share-link-manager', name: 'Share link manager', file: 'client/share-link-manager.js' },
  { id: 'island-file-browser', name: 'File browser', file: 'client/file-browser.js' },
  { id: 'island-tagline-hero', name: 'Landing tagline', file: 'client/tagline-hero.js' },
  { id: 'island-header-bar', name: 'Header bar', file: 'client/header-bar.js' },
  { id: 'island-input-row', name: 'Composer input row', file: 'client/input-row.js' },
  // The shared confined-Preact UI kit every island builds on (Card/Chip/Btn/EmptyState/Meta).
  { id: 'island-ui-kit', name: 'UI kit (primitives)', file: 'client/ui-kit.js' },
  // The 3D conversation-trace view. It's a standalone served script (public/pendant.js), NOT part of
  // the vite islands bundle, so it's `plain`: editing rewrites the file directly (no rebuild).
  { id: 'island-trace', name: 'Trace view (3D)', file: 'public/pendant.js', plain: true },
];

export const makeIslandSource = ({ here, componentGit }) => {
  const env = { ...process.env, PATH: `${process.env.HOME || '/home/dan'}/.local/bin:${process.env.PATH || ''}` }; // corepack lives in the user prefix
  const get = id => ISLANDS.find(i => i.id === String(id)) || null;
  const isIsland = id => !!get(id);
  const list = () => ISLANDS.map(i => ({ id: i.id, name: i.name, kind: 'island' }));
  const readSource = isl => { try { return fs.readFileSync(path.join(here, isl.file), 'utf8'); } catch { return ''; } };
  const filesOf = isl => ({ [isl.file]: readSource(isl) });

  // Seed the island's git lineage from the current client source, once.
  const ensure = async isl => { if (!componentGit.exists(isl.id)) await componentGit.commit(isl.id, filesOf(isl), `seed: ${isl.name}`); };

  const history = async id => { const isl = get(id); if (!isl) return []; await ensure(isl); return componentGit.history(id); };
  const readAt = async (id, ref) => { const isl = get(id); if (!isl) return null; await ensure(isl); return componentGit.readAt(id, ref); };
  const readSourceText = async (id, ref = 'HEAD') => { const snap = await readAt(id, ref); return snap ? (snap.files[get(id).file] ?? '') : null; };

  const rebuild = async () => { try { await execFileP('corepack', ['yarn', 'build:islands'], { cwd: here, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; } };

  // Replace the island's source, REBUILD, and version it. If the build fails, restore the old file +
  // report — the live bundle (only overwritten by a successful build) is never left broken.
  const applySource = async (id, newSource, message) => {
    const isl = get(id); if (!isl) return { ok: false, error: 'unknown island' };
    await ensure(isl);
    const backup = readSource(isl); const abs = path.join(here, isl.file);
    try {
      fs.writeFileSync(abs, String(newSource ?? ''));
      const b = isl.plain ? { ok: true } : await rebuild(); // plain islands are served directly — no vite rebuild
      if (!b.ok) { fs.writeFileSync(abs, backup); return { ok: false, error: `build failed (reverted, live unchanged): ${b.error}` }; }
      const rec = await componentGit.commit(id, filesOf(isl), message || 'edit');
      return { ok: true, version: rec.version, note: `Edited${isl.plain ? '' : ' + rebuilt'} the island. Reload the page to see it. Revert from the Components tab if needed.` };
    } catch (e) { try { fs.writeFileSync(abs, backup); } catch { /* ignore */ } return { ok: false, error: (e && e.message) || String(e) }; }
  };
  const revert = async (id, ref) => { const src = await readSourceText(id, ref); if (src === null) return { ok: false, error: 'unknown version' }; return applySource(id, src, `revert to ${String(ref).slice(0, 12)}`); };

  return { isIsland, get, list, history, readAt, readSourceText, applySource, revert, fileOf: id => get(id)?.file };
};
harden(makeIslandSource);
