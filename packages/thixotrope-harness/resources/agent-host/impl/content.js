// @ts-check
/**
 * The `Content` exo (M1b W1b.1; `designs/m1b-interfaces.md` sections 3.1
 * and 11): one per adapter incarnation. It reads any blob whose handle the
 * caller holds, a page at a time (`blobPageBytes` at most, whole code
 * points), straight from the blob store in this process; no vat is on the
 * path. Holders: the exec vat for one call (`ExecRequest.content`), tests
 * and operators (`AgentHostAdmin.content()`), and (M3) the gateway.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { interfaces } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @param {{ store: import('./blobs.js').BlobStore }} options
 */
export const makeContent = ({ store }) =>
  makeExo('Content', interfaces.Content, {
    /**
     * @param {any} blob
     * @param {{ offset: number, maxBytes: number }} range
     */
    read: (blob, { offset, maxBytes }) =>
      store.readPage(blob, offset, maxBytes),
  });
harden(makeContent);
