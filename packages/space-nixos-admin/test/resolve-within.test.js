// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { sep } from 'node:path';

import { resolveWithin } from '../caplet.js';

const BASE = '/var/lib/endo/nixos-config';

test('resolves a plain relative path within the base', t => {
  t.is(resolveWithin(BASE, 'modules/endo.nix'), `${BASE}/modules/endo.nix`);
  t.is(resolveWithin(BASE, 'flake.nix'), `${BASE}/flake.nix`);
});

test('normalizes redundant segments that stay inside', t => {
  t.is(resolveWithin(BASE, 'modules/../flake.nix'), `${BASE}/flake.nix`);
});

test('rejects absolute paths', t => {
  t.throws(() => resolveWithin(BASE, '/etc/passwd'), {
    message: /escapes the config directory/,
  });
});

test('rejects parent-directory escapes', t => {
  t.throws(() => resolveWithin(BASE, '../secrets.env'), {
    message: /escapes the config directory/,
  });
  t.throws(() => resolveWithin(BASE, 'modules/../../etc/shadow'), {
    message: /escapes the config directory/,
  });
});

test('rejects the base itself (must name a file/subpath)', t => {
  t.throws(() => resolveWithin(BASE, '.'), {
    message: /escapes the config directory/,
  });
});

test('rejects the .git directory and its contents', t => {
  t.throws(() => resolveWithin(BASE, '.git'), {
    message: /\.git directory is not editable/,
  });
  t.throws(() => resolveWithin(BASE, `.git${sep}config`), {
    message: /\.git directory is not editable/,
  });
});

test('rejects empty and non-string paths', t => {
  t.throws(() => resolveWithin(BASE, ''), {
    message: /non-empty relative path/,
  });
  // @ts-expect-error deliberately wrong type
  t.throws(() => resolveWithin(BASE, undefined), {
    message: /non-empty relative path/,
  });
});
