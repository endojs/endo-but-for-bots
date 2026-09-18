// @ts-check
// A bounded, per-session static publisher exposed to a Floot session as a
// discoverable tool (`publishWorkspace`). It is deliberately narrow: it can
// serve ONLY this session's own workspace, over the shared asset server, and it
// never hands the session the asset server itself or the general `serveAt()`
// authority (which would let a session mint stable, guessable public paths or
// serve arbitrary filesystems).
//
// `serve()` returns an unguessable capability URL (192 bits of entropy in the
// path) and the `id` of the served item. The asset server is the retention
// root for what it serves: it takes its own read-only facet of the workspace
// on receipt, keeps that, and restores the route itself after a restart. So
// the workspace capability is handed over as it is — the daemon-minted cap,
// which the server can retain; a view built here could not outlive this
// worker — and the publication belongs to the session, not to this tool
// instance: the factory records `{ id, url }` with the session, a rebuilt
// tool finds it there and the URL it reports is the one already handed out,
// and only deleting the session releases it.
//
// The tool is installed for every session that has a project workspace, whether
// or not an asset server is bound yet, and resolves the server per publish. A
// tool that came and went with the server's availability would change the
// session's tool-set identity between incarnations, and a hosted backend that
// pins that identity to its thread (Codex) would abandon the model's
// conversation each time it flipped.
//
// The tool runs in the Floot factory worker, OUTSIDE any sandbox container: an
// API-backed session reaches it through the normal tool loop, and a hosted
// session reaches it through the pinned tool set its backend bridges in — both
// via the session's tool registry, so neither path needs special casing.

import { E } from '@endo/eventual-send';
import { mountAsFilesystem } from '@endo/platform/fs/extended/from-mount.js';

/**
 * Project a session's workspace capability onto the endo-fs `Filesystem` the
 * asset server walks (`root()` -> `lookup()` -> `open()`).
 *
 * A session's `git-workspace` preset object is an `@endo/exo-git` cap, and the
 * worktree under it is a Mount. Neither answers `root()`, so handing either
 * straight to `serve()` produced a URL whose every request 404'd at the first
 * step of the walk — indistinguishably from a revoked or mistyped link.
 * The classification follows `@endo/space-file-explorer`'s
 * `classifyCapability`, the other place in this repo that adapts these three
 * shapes.
 *
 * Git is projected through its worktree rather than `filesystemAt(ref)`, so an
 * agent publishes the files it just wrote instead of the last commit — an
 * unborn repository is the normal case here. Both projections go through the
 * cap's own read-only facet: publishing is a read, and the served mount must
 * never carry write authority into the asset server.
 *
 * @param {any} workspace
 * @returns {Promise<any>}
 */
const toServableFilesystem = async workspace => {
  // eslint-disable-next-line no-underscore-dangle
  const names = new Set(await E(workspace).__getMethodNames__());
  if (names.has('root') && names.has('statfs')) {
    return workspace;
  }
  if (names.has('worktree') && names.has('status') && names.has('commit')) {
    const mount = await E(await E(workspace).readOnly()).worktree();
    return mountAsFilesystem(mount, { posture: 'readOnly' });
  }
  if (
    names.has('lookup') &&
    (names.has('makeDirectory') || names.has('writeText') || names.has('list'))
  ) {
    return mountAsFilesystem(await E(workspace).readOnly(), {
      posture: 'readOnly',
    });
  }
  throw Error(
    'This session’s workspace is not a Filesystem, Mount, or Git ' +
      'capability, so it cannot be served as a static site.',
  );
};

/** The directory index `@endo/endo-fs-asset-server` resolves a directory
 * request to. `serve()` takes it as an option and defaults to this; the
 * publisher passes no options, so this is what a published root will look
 * for. */
const INDEX_FILE = 'index.html';

/**
 * Whether the projected filesystem has a readable index at its root.
 *
 * Mirrors the asset server's own resolution: walk `root()` to the index and
 * confirm the node is a file, distinguished by `open` the way the request
 * path distinguishes it, rather than by duck-typing an attribute read.
 *
 * Only the root is required to resolve. A published mount still serves every
 * other path, so this is a requirement about the *link* — which points at the
 * root — not about what the mount may contain. An agent that wants to publish
 * arbitrary files writes a root index that links to them.
 *
 * @param {any} filesystem
 * @returns {Promise<boolean>}
 */
const hasReadableIndex = async filesystem => {
  await null;
  try {
    const node = await E(E(filesystem).root()).lookup(INDEX_FILE);
    // eslint-disable-next-line no-underscore-dangle
    const methods = await E(node).__getMethodNames__();
    return methods.includes('open');
  } catch {
    // An absent entry, an unreadable root, or an index that is a directory:
    // all of them mean the published root would 404.
    return false;
  }
};

// The wording is part of the tool set's identity, which a hosted backend pins
// to its thread (Codex rotates the thread when it changes), so it is left as
// it was: calling again is still harmless, and the reply says what is true
// now — the URL is stable and serves the live files.
/** @type {import('@endo/fae/src/tool-makers.js').ToolSchema} */
const publishSchema = harden({
  type: 'function',
  function: {
    name: 'publishWorkspace',
    description:
      'Publish this project workspace as a static website and return a ' +
      'shareable URL. The URL is an unguessable capability link that opens ' +
      'in a new browser tab. Call it again after you change files to serve ' +
      'the latest version. Only this session’s own workspace can be ' +
      'published.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

/**
 * @typedef {{ id: string, url: string }} Publication
 */

/**
 * @param {object} options
 * @param {() => Promise<any>} options.getAssetServer - resolves the shared
 *   asset server's serve-only facet (`serve`, `describe`, `release`), or a
 *   falsy value while none is bound. Resolved on every publish: the hosted
 *   setup binds the server late in the boot, and a re-bound server must
 *   replace a dead presence.
 * @param {() => Promise<any>} options.getWorkspace - resolves this session's
 *   workspace cap (an EndoGit workspace, Mount, or Filesystem), or a falsy
 *   value if the session has none. It is handed to the server as it is; the
 *   projection here is only to check that the root would resolve.
 * @param {() => Promise<Publication | undefined>} [options.loadPublication]
 *   the session's recorded publication, if any. With `savePublication`, this
 *   is what makes a publication outlive the tool instance and the daemon;
 *   without them it lasts as long as this instance.
 * @param {(publication: Publication | undefined) => Promise<void>} [options.savePublication]
 * @param {string} [options.label] shown to the asset server's administrator.
 * @returns {import('@endo/fae/src/tool-makers.js').FaeTool & { revoke: () => Promise<void> }}
 */
export const makePublishTool = ({
  getAssetServer,
  getWorkspace,
  loadPublication = undefined,
  savePublication = undefined,
  label = '',
}) => {
  /** @type {Publication | undefined} */
  let remembered;
  const load = async () =>
    loadPublication ? loadPublication() : Promise.resolve(remembered);
  /** @param {Publication | undefined} publication */
  const save = async publication => {
    if (savePublication) {
      await savePublication(publication);
    } else {
      remembered = publication;
    }
  };

  // Publishes and revocations run one at a time: a hosted CLI can issue two
  // tool calls in parallel, and two concurrent publishes would each serve a
  // mount while only the last was recorded — the other would never be
  // released.
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} thunk
   * @returns {Promise<T>}
   */
  const serialize = thunk => {
    const next = chain.then(thunk, thunk);
    chain = next.catch(() => {});
    return next;
  };

  const published = url =>
    `Published your workspace at ${url}\n` +
    'This is an unguessable capability URL; it opens in a new browser ' +
    'tab. It serves the files as they are now, so edits show on reload, ' +
    'and it stays the same across restarts until this session is deleted.';

  const publish = async () => {
    const workspace = await getWorkspace();
    if (!workspace) {
      return 'This session has no project workspace to publish.';
    }
    const assetServer = await getAssetServer();
    if (!assetServer) {
      return (
        'Publishing is unavailable right now: no asset server is bound to ' +
        'this Floot. Try again later.'
      );
    }
    let filesystem;
    try {
      filesystem = await toServableFilesystem(workspace);
    } catch (error) {
      return `Publishing failed: ${/** @type {Error} */ (error).message}`;
    }
    if (!(await hasReadableIndex(filesystem))) {
      // `serve()` refuses a cap it cannot walk; this refuses a cap it can walk
      // and would find nothing in. The asset server resolves a directory
      // request to its index file, so a workspace without one publishes a URL
      // whose every request 404s — indistinguishable from a revoked or
      // mistyped link, which is the confusion this tool's projection already
      // exists to prevent. A backend whose slice writes somewhere other than
      // the session's workspace reaches exactly this state and reports
      // success, so the check belongs here rather than in the agent's hands.
      return (
        `Publishing failed: this workspace has no readable ${INDEX_FILE} at ` +
        `its root. The URL this returns points at the root, which resolves to ` +
        `${INDEX_FILE}, so it would return 404. Other files are still served ` +
        'at their own paths, so a root ' +
        `${INDEX_FILE} that links to them is enough. Write it into this ` +
        'session’s workspace — the same tree your file tools read — and ' +
        'publish again.'
      );
    }
    // The served tree is the live workspace, not a snapshot, so a publication
    // that still stands needs nothing done to it: report the URL already
    // handed out rather than minting a second one for the same files.
    const known = await load();
    if (known) {
      const standing = await E(assetServer).describe(known.id);
      if (standing) return published(standing.url);
    }
    const { id, url } = await E(assetServer).serve(workspace, { label });
    try {
      await save(harden({ id, url }));
    } catch (error) {
      // An unrecorded route would never be released; do not leave one.
      await E(assetServer)
        .release(id)
        .catch(() => {});
      return `Publishing failed: the publication could not be recorded: ${/** @type {Error} */ (error).message}`;
    }
    return published(url);
  };

  // Release the session's publication. Called when the session is deleted,
  // never when a tool instance is replaced.
  const revoke = async () => {
    const known = await load();
    if (!known) return;
    const assetServer = await getAssetServer();
    if (!assetServer) {
      throw Error(
        'The asset server is not bound, so this session’s published URL could not be released',
      );
    }
    await E(assetServer).release(known.id);
    await save(undefined);
  };

  return harden({
    schema: () => publishSchema,
    execute: () => serialize(publish),
    help: () =>
      'publishWorkspace() — serve this session’s project workspace as a ' +
      'static site and return a shareable capability URL.',
    // Not part of the tool wire; the factory calls it on session deletion to
    // release the served route.
    revoke: () => serialize(revoke),
  });
};
harden(makePublishTool);
