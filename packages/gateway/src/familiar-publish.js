// @ts-check

/**
 * @file `FamiliarPublisher` exo for the Familiar-bundled gateway
 *   variant (design Feature 5, Phase 9).
 *
 * Per `designs/gateway-package.md` Feature 5, when the Familiar
 * Electron shell embeds `@endo/gateway` and binds it on
 * `127.0.0.1:0`, the actual OS-assigned port must be surfaced to
 * the Familiar renderer's `localhttp://` protocol handler so it
 * can proxy weblet traffic to the right address. Today's
 * Familiar reads the gateway address from a state file
 * (`${statePath}/gateway`) the daemon writes after its built-in
 * gateway binds; see `packages/daemon/src/daemon-node.js` ~line
 * 195 and the Familiar's `getGatewayAddress` in
 * `packages/familiar/src/daemon-manager.js`. The file's payload
 * is a single URL line, `http://${host}:${port}\n`.
 *
 * The Familiar-bundled gateway preserves that contract: the
 * publisher writes the same URL shape to a caller-configurable
 * path, the Familiar reads it on startup, and the
 * `localhttp://` proxy targets the published address. The
 * publisher also removes the file on `cleanup()` so a quitting
 * Familiar does not leave a stale port behind.
 *
 * ### Why a separate module
 *
 * The publish path is platform-bound (`fs.promises.writeFile`,
 * `fs.promises.unlink`, `path.dirname`/`mkdir`). The gateway's
 * portable core never imports `node:fs` directly; instead, it
 * takes an `IoPowers` adapter and calls through it. This module
 * defines the publisher exo *and* the `IoPowers` shape; the
 * Node-side adapter lives in
 * `./node-familiar-publish-powers.js` next door.
 *
 * ### Fail-closed posture
 *
 * Phase 7's fail-closed-on-config-drift discipline applies: a
 * gateway configured for the Familiar-bundled variant
 * (`familiarBundled: true`) that fails to publish its bind
 * address surfaces the failure at `start()` rather than letting
 * the Familiar proxy to a stale port silently. The exo
 * propagates the underlying I/O error verbatim so the embedder's
 * supervisor can log a precise cause; the gateway's own
 * `start()` re-throws after marking the lifecycle `stopped`.
 *
 * ### Idempotence
 *
 * The publisher tolerates two cases:
 *
 * - **Re-publish**: a subsequent `publish(...)` call overwrites
 *   the file. This allows a gateway whose listener restarts on a
 *   new port (a follow-on PR's responsibility) to refresh the
 *   published value without tearing the file down first.
 * - **Cleanup with no publish**: `cleanup()` before any
 *   `publish()` is a no-op. The cleanup pathway is also tolerant
 *   of an externally-removed file (`ENOENT` is ignored) so a
 *   user who manually deleted the file does not crash the
 *   gateway's shutdown.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';

/** @import { IoPowers, FamiliarPublisher } from './types.d.ts' */

const PublisherInterface = M.interface('FamiliarPublisher', {
  publish: M.call(M.string()).returns(M.promise()),
  cleanup: M.call().returns(M.promise()),
  getPublishPath: M.call().returns(M.string()),
});
harden(PublisherInterface);

/**
 * The HTTP scheme the publisher renders. The Familiar's
 * `getGatewayAddress` parses the file's contents with `new
 * URL(...)`; any well-formed `http://` or `https://` URL
 * suffices. The Familiar-bundled gateway binds plain HTTP
 * (TLS termination is a system-service responsibility, see
 * `designs/gateway-package.md` § Familiar-bundled variant), so
 * the publisher hardcodes `http://`.
 */
const PUBLISH_SCHEME = 'http';

/**
 * Validate that a candidate string is a non-empty `host:port`
 * shape with a numeric port. Mirrors the wire shape
 * `parseBindAddress` produces in `./config.js`; we duplicate the
 * parser-side check here so an in-realm caller that hands us a
 * raw string (rather than a `BindAddress` record) cannot publish
 * a malformed URL.
 *
 * IPv6 hosts arrive in their unbracketed form from
 * `Gateway.getBindAddress`'s rendering for `kind: 'hostname'` and
 * `kind: 'ipv4'`, and in bracketed form for `kind: 'ipv6'`. The
 * URL we render preserves whichever shape the caller passes; the
 * Familiar's `URL` parser handles both.
 *
 * @param {string} bindAddress
 */
const validateBindAddress = bindAddress => {
  if (typeof bindAddress !== 'string' || bindAddress.length === 0) {
    throw makeError(
      X`bindAddress must be a non-empty string, got ${q(bindAddress)}`,
    );
  }
  // The bind address must include a port (the publisher's whole
  // job is to surface the OS-assigned port). The trailing
  // `:<digits>` is the load-bearing shape; `parseBindAddress`
  // rejects everything else.
  if (!/:[0-9]+$/.test(bindAddress)) {
    throw makeError(
      X`bindAddress must end with :<port>, got ${q(bindAddress)}`,
    );
  }
};

/**
 * @param {object} args
 * @param {IoPowers} args.io
 * @param {string} args.publishPath Absolute path the publisher
 *   writes the gateway URL to. The caller (the embedder or the
 *   gateway proper) decides where this lives; the Familiar
 *   convention today is `${statePath}/gateway` where `statePath`
 *   is the per-user state directory (`whereEndoState(...)` in
 *   `packages/where`). Passing an absolute path keeps the
 *   publisher portable across embedders that choose different
 *   layouts.
 * @returns {FamiliarPublisher}
 */
export const makeFamiliarPublisher = ({ io, publishPath }) => {
  if (io === undefined || io === null) {
    throw makeError(X`makeFamiliarPublisher requires io powers`);
  }
  if (typeof io.writeFile !== 'function') {
    throw makeError(X`io.writeFile must be a function`);
  }
  if (typeof io.removeFile !== 'function') {
    throw makeError(X`io.removeFile must be a function`);
  }
  if (typeof publishPath !== 'string' || publishPath.length === 0) {
    throw makeError(
      X`publishPath must be a non-empty string, got ${q(publishPath)}`,
    );
  }

  let published = false;

  const exo = makeExo(
    'FamiliarPublisher',
    PublisherInterface,
    /** @type {any} */ ({
      /** @param {string} bindAddress */
      async publish(bindAddress) {
        validateBindAddress(bindAddress);
        // Render the URL the Familiar's `new URL(...)` parser
        // consumes; the trailing newline matches the daemon's
        // `${statePath}/gateway` file format so a Familiar that
        // does not distinguish between daemon-published and
        // gateway-published files reads either uniformly.
        const url = `${PUBLISH_SCHEME}://${bindAddress}\n`;
        await io.writeFile(publishPath, url);
        published = true;
      },
      async cleanup() {
        if (!published) {
          return;
        }
        // The adapter tolerates `ENOENT`; we do not gate on
        // `published` to allow a cleanup-after-external-removal
        // path. Setting `published = false` afterwards lets a
        // subsequent `publish` re-write the file without
        // assuming the prior state.
        await io.removeFile(publishPath);
        published = false;
      },
      getPublishPath() {
        return publishPath;
      },
    }),
  );
  return /** @type {FamiliarPublisher} */ (/** @type {unknown} */ (exo));
};
harden(makeFamiliarPublisher);
