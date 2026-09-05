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

test('rejects a nested .git at any depth, as the walkers do', t => {
  // walkFiles and fingerprintConfig skip `.git` at every depth, so a nested
  // one that stayed writable would be editable yet outside both the listing
  // and the fingerprint binding the request to what the service may build.
  t.throws(() => resolveWithin(BASE, `sub${sep}.git`), {
    message: /\.git directory is not editable/,
  });
  t.throws(
    () => resolveWithin(BASE, `sub${sep}.git${sep}hooks${sep}pre-push`),
    {
      message: /\.git directory is not editable/,
    },
  );
  t.throws(() => resolveWithin(BASE, `a${sep}b${sep}.git${sep}config`), {
    message: /\.git directory is not editable/,
  });
});

test('a normalized path cannot smuggle a .git component past the check', t => {
  t.throws(() => resolveWithin(BASE, `sub${sep}..${sep}.git${sep}config`), {
    message: /\.git directory is not editable/,
  });
});

test('names that merely start with .git stay editable', t => {
  t.is(resolveWithin(BASE, '.gitignore'), `${BASE}/.gitignore`);
  t.is(
    resolveWithin(BASE, `sub${sep}.gitattributes`),
    `${BASE}/sub/.gitattributes`,
  );
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
