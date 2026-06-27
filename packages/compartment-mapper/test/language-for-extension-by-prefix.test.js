// @ts-nocheck
import 'ses';
import test from 'ava';
import {
  languageForExtensionOverride,
  layerLanguageForExtension,
  selectLanguageForExtension,
} from '../src/language-for-extension-by-prefix.js';

test('languageForExtensionOverride flips js by type', t => {
  t.is(languageForExtensionOverride({ type: 'module' }).js, 'mjs');
  t.is(languageForExtensionOverride({ type: 'commonjs' }).js, 'cjs');
  // A `module` field (no `type`) implies ECMAScript modules.
  t.is(languageForExtensionOverride({ module: './index.js' }).js, 'mjs');
  // No type and no module: nothing to flip.
  t.deepEqual({ ...languageForExtensionOverride({}) }, {});
});

test('languageForExtensionOverride flips ts by type, mirroring Node.js', t => {
  // `.ts` is type-dependent exactly like `.js`: Node.js classifies it as an
  // ECMAScript module under `type: "module"` and as CommonJS under
  // `type: "commonjs"`. The unambiguous `.mts`/`.cts` are never flipped — they
  // are always module / CommonJS respectively — so the override leaves them
  // out, just as it leaves out `.mjs`/`.cjs`.
  t.is(languageForExtensionOverride({ type: 'module' }).ts, 'mts');
  t.is(languageForExtensionOverride({ type: 'commonjs' }).ts, 'cts');
  // A `module` field (no `type`) implies ECMAScript modules for `.ts` too.
  t.is(languageForExtensionOverride({ module: './index.ts' }).ts, 'mts');
  // No type and no module: nothing to flip, including `.ts`.
  t.is(languageForExtensionOverride({}).ts, undefined);
  // `.mts`/`.cts` are type-independent and never appear in the override.
  t.is(languageForExtensionOverride({ type: 'commonjs' }).mts, undefined);
  t.is(languageForExtensionOverride({ type: 'module' }).cts, undefined);
});

test('languageForExtensionOverride layers an explicit parsers map over the type flip', t => {
  const override = languageForExtensionOverride({
    type: 'commonjs',
    parsers: { js: 'mjs', mts: 'mjs' },
  });
  // Explicit parsers win over the type-implied flip.
  t.is(override.js, 'mjs');
  t.is(override.mts, 'mjs');
});

test('layerLanguageForExtension overlays deeper descriptors onto a base, deeper winning', t => {
  const base = { js: 'mjs', json: 'json' };
  const layered = layerLanguageForExtension(base, { type: 'commonjs' });
  t.is(layered.js, 'cjs');
  // Untouched extensions are preserved from the base.
  t.is(layered.json, 'json');
  // The base is not mutated.
  t.is(base.js, 'mjs');
});

test('selectLanguageForExtension chooses the deepest matching prefix', t => {
  const base = { js: 'mjs' };
  const byPrefix = [
    { prefix: 'cjs-sub/', languageForExtension: { js: 'cjs' } },
    { prefix: 'cjs-sub/esm-again/', languageForExtension: { js: 'mjs' } },
  ];
  // No prefix matches: fall back to base.
  t.is(selectLanguageForExtension(base, byPrefix, 'root-mod.js').js, 'mjs');
  // Shallow prefix matches.
  t.is(selectLanguageForExtension(base, byPrefix, 'cjs-sub/leaf.js').js, 'cjs');
  // A directory with no own descriptor inherits the nearest matching prefix.
  t.is(
    selectLanguageForExtension(base, byPrefix, 'cjs-sub/deep/again.js').js,
    'cjs',
  );
  // The deeper, longer prefix wins over the shallower one.
  t.is(
    selectLanguageForExtension(base, byPrefix, 'cjs-sub/esm-again/remod.js').js,
    'mjs',
  );
});

test('selectLanguageForExtension returns base when the prefix list is empty', t => {
  const base = { js: 'cjs' };
  t.is(selectLanguageForExtension(base, [], 'a/b/c.js'), base);
});
