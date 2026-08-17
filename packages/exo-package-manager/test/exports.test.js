// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { readFile } from 'node:fs/promises';

test('types-index subpath resolves through package exports', async t => {
  const typesIndex = await import('@endo/exo-package-manager/types-index.js');
  t.is(typeof typesIndex.makePackageManager, 'function');
  t.is(typeof typesIndex.makePackageManagerKit, 'function');
});

test('published declaration uses runtime module specifiers', async t => {
  const declaration = await readFile(
    new URL('../types-index.types.d.ts', import.meta.url),
    'utf8',
  );
  t.regex(declaration, /export type \* from '\.\/src\/types\.js';/);
  t.notRegex(declaration, /from ['"][^'"]+\.ts['"]/);
});
