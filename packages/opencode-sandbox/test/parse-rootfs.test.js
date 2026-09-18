// @ts-check
import '@endo/init';
import test from 'ava';

import { parseRootfs } from '../src/parse-rootfs.js';

test.serial(
  'OpenCode resolves its default image without a doubled OCI prefix',
  t => {
    const prior = process.env.ENDO_OPENCODE_SANDBOX_IMAGE;
    t.teardown(() => {
      if (prior === undefined) delete process.env.ENDO_OPENCODE_SANDBOX_IMAGE;
      else process.env.ENDO_OPENCODE_SANDBOX_IMAGE = prior;
    });
    delete process.env.ENDO_OPENCODE_SANDBOX_IMAGE;
    t.deepEqual(parseRootfs(''), {
      kind: 'oci',
      ref: 'localhost/opencode:latest',
    });
    process.env.ENDO_OPENCODE_SANDBOX_IMAGE = 'oci:localhost/operator:latest';
    t.deepEqual(parseRootfs(undefined), {
      kind: 'oci',
      ref: 'localhost/operator:latest',
    });
    t.deepEqual(
      parseRootfs('', { defaultImage: 'oci:localhost/explicit:latest' }),
      {
        kind: 'oci',
        ref: 'localhost/explicit:latest',
      },
    );
  },
);
