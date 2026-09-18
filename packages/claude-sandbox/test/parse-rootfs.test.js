// @ts-check
import '@endo/init';
import test from 'ava';

import { parseRootfs } from '../src/parse-rootfs.js';

test('Claude retains its base image and normalizes operator defaults', t => {
  t.deepEqual(parseRootfs(''), {
    kind: 'oci',
    ref: 'docker.io/library/node:22-bookworm-slim',
  });
  t.deepEqual(
    parseRootfs('', { defaultImage: 'oci:localhost/claude:latest' }),
    {
      kind: 'oci',
      ref: 'localhost/claude:latest',
    },
  );
});
