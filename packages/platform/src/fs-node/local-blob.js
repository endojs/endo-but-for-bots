// @ts-check

/**
 * Ambient-authority factory for a read-only ReadableBlob exo backed by an
 * arbitrary absolute filesystem path.
 *
 * The capability returned by `makeLocalBlob` conveys read authority on
 * exactly that path: any holder can stream or load its contents.
 *
 * This factory is intended for host-side use.
 * It must never cross the daemon membrane to a guest, worker, caplet, or
 * chat-side bot; doing so would hand that party ambient read authority to
 * whatever path the host process can open.
 * Confined `ReadableBlob` references reach agents only via the `Mount`
 * exo, which clamps paths to a confined subtree before composing this
 * factory.
 * See `designs/platform-fs-daemon-integration.md`.
 */

import fs from 'node:fs';
import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { makeNodeReader } from '@endo/stream-node';

import { ReadableBlobInterface } from '../fs/interfaces.js';
import { makeReaderRef } from '../fs/reader-ref.js';

/**
 * Creates a ReadableBlob Exo from a local file.
 * Streams file content as base64 via @endo/stream-node.
 *
 * @param {string} filePath
 */
export const makeLocalBlob = filePath => {
  return makeExo('LocalBlob', ReadableBlobInterface, {
    streamBase64: () => {
      const nodeReadStream = fs.createReadStream(filePath);
      const reader = makeNodeReader(nodeReadStream);
      return makeReaderRef(reader);
    },
    text: () => fs.promises.readFile(filePath, 'utf-8'),
    json: async () => JSON.parse(await fs.promises.readFile(filePath, 'utf-8')),
  });
};
harden(makeLocalBlob);
