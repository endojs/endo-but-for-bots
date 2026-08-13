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
// The tool runs in the Floot factory worker, OUTSIDE any sandbox container: an
// API-backed session reaches it through the normal tool loop, and a Claude CLI
// session reaches it through the per-session MCP bridge — both via
// discoverTools, so neither path needs special casing.

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
      'the latest version. Only this session\u2019s own workspace can be ' +
      'published.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

/**
 * @param {object} options
 * @param {any} options.assetServer - the shared AssetServer cap (serve()).
 * @param {() => Promise<any>} options.getWorkspace - resolves this session's
 *   workspace cap (an EndoGit workspace, Mount, or Filesystem), or a falsy
 *   value if the session has none.
 * @returns {import('@endo/fae/src/tool-makers.js').FaeTool & { revoke: () => Promise<void> }}
 */
export const makePublishTool = ({ assetServer, getWorkspace }) => {
  /** @type {{ url: string, revoker: any } | undefined} */
  let current;

  const dropCurrent = async () => {
    if (current) {
      const { revoker } = current;
      current = undefined;
      await E(revoker)
        .revoke()
        .catch(() => {});
    }
  };

  return harden({
    schema: () => publishSchema,
    execute: async () => {
      const workspace = await getWorkspace();
      if (!workspace) {
        return 'This session has no project workspace to publish.';
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
    },
    help: () =>
      'publishWorkspace() — serve this session\u2019s project workspace as a ' +
      'static site and return a shareable capability URL.',
    // Not part of the tool wire; the factory calls it on session deletion (and
    // on rebuild) to release the served mount.
    revoke: dropCurrent,
  });
};
harden(makePublishTool);
