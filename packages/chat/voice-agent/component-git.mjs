// component-git.mjs — a component's SOURCE as a git-as-Endo object (Phase 2 of the component-trie:
// designs/preact-component-trie.md). Each component-project is its OWN git repository, backed by the
// real `@endo/git` NativeGitBackend (the endo-git capability over the installed git binary). This gives
// every component:
//   • versioned history (each edit = a commit; the commit oid IS the version),
//   • read-at-a-version (the immutable git tree as a filesystem view — git-as-folder-object),
//   • fork (a full clone → an independent lineage the forker owns + can diverge),
//   • revert (re-commit an earlier tree — non-destructive, history preserved).
// The component's SOURCE lives here (versioned); its DATA lives in grains (cells) — they are separate
// (see ISLAND-AUTHORING.md). This module is the source-versioning substrate; the full EndoGit exo (a
// remotable, attenuable cap for the trie, via makeGit + a mount) layers on top later.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { makeNativeGitBackend } from '@endo/git';

const execFileP = promisify(execFile);

export const makeComponentGit = ({ baseDir }) => {
  fs.mkdirSync(baseDir, { recursive: true });
  const backends = new Map(); // id → NativeGitBackend
  const repoDir = id => path.join(baseDir, encodeURIComponent(String(id)).replace(/%/g, '_'));

  const ensureRepo = async id => {
    const dir = repoDir(id);
    let backend = backends.get(id);
    if (!backend) {
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(dir, { recursive: true });
        await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir });
        await execFileP('git', ['config', 'user.email', 'components@archua.local'], { cwd: dir });
        await execFileP('git', ['config', 'user.name', 'component-git'], { cwd: dir });
      }
      backend = makeNativeGitBackend({ repoRoot: dir });
      await backend.assertRepositoryRoot();
      backends.set(id, backend);
    }
    return { dir, backend };
  };

  // Overwrite the working tree with EXACTLY `files` (a {relpath: content} map) — so a commit is a
  // faithful snapshot (removed files are dropped, not carried forward).
  const writeTree = (dir, files) => {
    for (const name of fs.readdirSync(dir)) { if (name !== '.git') fs.rmSync(path.join(dir, name), { recursive: true, force: true }); }
    for (const [rel, content] of Object.entries(files || {})) {
      const clean = String(rel).replace(/^[/\\]+/, '');
      if (!clean || clean.includes('..')) continue;
      const abs = path.join(dir, clean);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''));
    }
  };

  // Commit a component's files as a new VERSION. Returns { version (commit oid), summary, at }.
  const commit = async (id, files, message = 'update') => {
    const { dir, backend } = await ensureRepo(id);
    writeTree(dir, files);
    await execFileP('git', ['add', '-A'], { cwd: dir }); // -A captures additions, edits, AND deletions
    // nothing staged (identical content) → return the current HEAD instead of erroring on an empty commit
    const { stdout: staged } = await execFileP('git', ['diff', '--cached', '--name-only'], { cwd: dir });
    if (!staged.trim()) { const [head] = await backend.log({ maxCount: 1 }); return head ? { version: head.oid, summary: head.summary, at: head.committedAt, unchanged: true } : { version: null }; }
    const rec = await backend.commit(String(message || 'update'));
    return { version: rec.oid, summary: rec.summary, at: rec.committedAt };
  };

  // Read a component's files AT a version (default latest) — the immutable git tree as a file map.
  const readAt = async (id, ref = 'HEAD') => {
    const { backend } = await ensureRepo(id);
    let tree;
    try { tree = await backend.tree(ref); } catch { return null; }
    const files = {};
    const walk = async (node, prefix) => {
      const names = await node.list();
      for (const name of names) {
        const child = await node.lookup(name); // GitTree (has .list) or GitBlob (has .text, no .list)
        if (typeof child.list === 'function') await walk(child, `${prefix}${name}/`);
        else files[`${prefix}${name}`] = await child.text();
      }
    };
    await walk(tree, '');
    return { files, version: ref };
  };

  // Version history (newest first): [{ version, summary, at }].
  const history = async id => {
    const { backend } = await ensureRepo(id);
    const commits = await backend.log({ maxCount: 100 });
    return commits.map(c => ({ version: c.oid, summary: c.summary, at: c.committedAt }));
  };

  // FORK: clone the whole repo to a NEW component id at `fromRef` — an independent lineage the forker
  // owns and can diverge, while the original is untouched.
  const fork = async (srcId, newId, fromRef = 'HEAD') => {
    const { dir: srcDir } = await ensureRepo(srcId);
    const dstDir = repoDir(newId);
    if (fs.existsSync(path.join(dstDir, '.git'))) throw new Error(`component "${newId}" already exists`);
    fs.mkdirSync(path.dirname(dstDir), { recursive: true });
    await execFileP('git', ['clone', '-q', srcDir, dstDir]);
    await execFileP('git', ['config', 'user.email', 'components@archua.local'], { cwd: dstDir });
    await execFileP('git', ['config', 'user.name', 'component-git'], { cwd: dstDir });
    if (fromRef && fromRef !== 'HEAD') await execFileP('git', ['reset', '--hard', fromRef], { cwd: dstDir });
    backends.set(newId, makeNativeGitBackend({ repoRoot: dstDir }));
    const [head] = await (backends.get(newId)).log({ maxCount: 1 });
    return { id: newId, forkedFrom: srcId, version: head ? head.oid : null };
  };

  // REVERT: re-commit the tree at `toRef` as a new HEAD — non-destructive (history is preserved; you can
  // go forward or back again). Returns the new version.
  const revert = async (id, toRef) => {
    const snapshot = await readAt(id, toRef);
    if (!snapshot) throw new Error(`unknown version ${toRef}`);
    return commit(id, snapshot.files, `revert to ${String(toRef).slice(0, 12)}`);
  };

  const exists = id => fs.existsSync(path.join(repoDir(id), '.git'));

  return { commit, readAt, history, fork, revert, exists };
};
harden(makeComponentGit);
