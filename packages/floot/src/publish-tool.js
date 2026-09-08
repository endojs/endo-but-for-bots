// @ts-check
// A bounded, per-session static publisher exposed to a Floot session as a
// discoverable tool (`publishWorkspace`). It is deliberately narrow: it can
// serve ONLY this session's own workspace, over the shared asset server, and it
// never hands the session the asset server itself or the general `serveAt()`
// authority (which would let a session mint stable, guessable public paths or
// serve arbitrary filesystems).
//
// `serve()` returns an unguessable capability URL (192 bits of entropy in the
// path). We retain the revoker so the factory can revoke the mount when the
// session is deleted, and so re-publishing after edits first drops the old
// mount rather than leaking listeners.
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
 * @param {object} options
 * @param {() => Promise<any>} options.getAssetServer - resolves the shared
 *   AssetServer cap (serve()), or a falsy value while none is bound. Resolved
 *   on every publish: the hosted setup binds the server late in the boot, and
 *   a re-bound server must replace a dead presence.
 * @param {() => Promise<any>} options.getWorkspace - resolves this session's
 *   workspace cap (an EndoGit workspace, Mount, or Filesystem), or a falsy
 *   value if the session has none.
 * @returns {import('@endo/fae/src/tool-makers.js').FaeTool & { revoke: () => Promise<void> }}
 */
export const makePublishTool = ({ getAssetServer, getWorkspace }) => {
  /** @type {{ url: string, revoker: any } | undefined} */
  let current;
  // Publishes and revocations run one at a time: a hosted CLI can issue two
  // tool calls in parallel, and two concurrent publishes would each serve a
  // mount while only the last was retained — the other's listener leaked.
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

  const dropCurrent = async () => {
    await null;
    if (current) {
      const { revoker } = current;
      current = undefined;
      await E(revoker)
        .revoke()
        .catch(() => {});
    }
  };

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
    // Refresh: drop any prior mount so a re-publish serves current files and
    // never accumulates listeners.
    await dropCurrent();
    const { url, revoke } = await E(assetServer).serve(workspace);
    current = { url, revoker: revoke };
    return (
      `Published your workspace at ${url}\n` +
      'This is an unguessable capability URL; it opens in a new browser ' +
      'tab. Re-run publishWorkspace after edits to refresh it.'
    );
  };

  return harden({
    schema: () => publishSchema,
    execute: () => serialize(publish),
    help: () =>
      'publishWorkspace() — serve this session’s project workspace as a ' +
      'static site and return a shareable capability URL.',
    // Not part of the tool wire; the factory calls it on session deletion (and
    // on rebuild) to release the served mount.
    revoke: () => serialize(dropCurrent),
  });
};
harden(makePublishTool);
