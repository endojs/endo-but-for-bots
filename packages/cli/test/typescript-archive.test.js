import '@endo/init/debug.js';

import test from 'ava';
import { transformSync } from 'amaro';
import { parseArchive } from '@endo/compartment-mapper';
import { defaultParserForLanguage } from '@endo/compartment-mapper/import-archive-all-parsers.js';
import { defaultParserForLanguage as sourceParserForLanguage } from '@endo/compartment-mapper/import-parsers.js';

import { makeCliArchive } from '../src/cli-archive.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Wrap a source parser so it records whether it was handed raw (un-stripped)
 * TypeScript, stripping the types itself so the resulting archive stays valid.
 * Used to prove that an explicitly supplied TypeScript parser is honored
 * verbatim rather than being re-wrapped in the CLI's strip-only transformer.
 *
 * @param {import('@endo/compartment-mapper').ParserImplementation} sourceParser
 * @param {{ sawRawTypeScript: boolean }} spy
 * @returns {import('@endo/compartment-mapper').AsyncParserImplementation}
 */
const makeStrippingSpyParser = (sourceParser, spy) => ({
  ...sourceParser,
  synchronous: false,
  async parse(
    sourceBytes,
    specifier,
    moduleLocation,
    packageLocation,
    options = undefined,
  ) {
    const sourceText = textDecoder.decode(sourceBytes);
    if (/:\s*number/.test(sourceText)) {
      spy.sawRawTypeScript = true;
    }
    const { code } = transformSync(sourceText, { mode: 'strip-only' });
    return sourceParser.parse(
      textEncoder.encode(code),
      specifier,
      moduleLocation,
      packageLocation,
      options,
    );
  },
});

const fixture = new URL(
  './fixtures/typescript-archive/main.js',
  import.meta.url,
).href;

test('CLI source archives erase module workspace TypeScript', async t => {
  const archive = await makeCliArchive(fixture);
  const application = await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import();

  t.is(namespace.main(), 42);
});

test('CLI TypeScript parser delegates to an overridden JavaScript parser', async t => {
  const sourceParser = sourceParserForLanguage.mjs;
  let delegated = false;
  const archive = await makeCliArchive(fixture, {
    parserForLanguage: {
      mjs: {
        ...sourceParser,
        synchronous: false,
        async parse(...args) {
          delegated = true;
          return sourceParser.parse(...args);
        },
      },
    },
  });
  await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });

  t.true(delegated);
});

test('CLI honors an explicitly supplied module TypeScript parser without re-wrapping it', async t => {
  const spy = { sawRawTypeScript: false };
  const archive = await makeCliArchive(fixture, {
    parserForLanguage: {
      mts: makeStrippingSpyParser(sourceParserForLanguage.mjs, spy),
    },
  });
  const application = await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import();

  // If the CLI had wrapped our parser in its strip-only transformer, the types
  // would already have been erased before our parser saw the source.
  t.true(spy.sawRawTypeScript, 'explicit mts parser received raw TypeScript');
  t.is(namespace.main(), 42);
});

const commonjsFixture = new URL(
  './fixtures/typescript-archive-commonjs/main.cjs',
  import.meta.url,
).href;

test('CLI source archives erase CommonJS workspace TypeScript', async t => {
  const archive = await makeCliArchive(commonjsFixture);
  const application = await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import();

  t.is(namespace.default, 42);
});

test('CLI TypeScript parser delegates to an overridden CommonJS parser', async t => {
  const sourceParser = sourceParserForLanguage.cjs;
  let delegated = false;
  const archive = await makeCliArchive(commonjsFixture, {
    parserForLanguage: {
      cjs: {
        ...sourceParser,
        synchronous: false,
        async parse(...args) {
          delegated = true;
          return sourceParser.parse(...args);
        },
      },
    },
  });
  await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });

  t.true(delegated);
});

test('CLI honors an explicitly supplied CommonJS TypeScript parser without re-wrapping it', async t => {
  const spy = { sawRawTypeScript: false };
  const archive = await makeCliArchive(commonjsFixture, {
    parserForLanguage: {
      cts: makeStrippingSpyParser(sourceParserForLanguage.cjs, spy),
    },
  });
  const application = await parseArchive(archive, '<typescript fixture>', {
    parserForLanguage: defaultParserForLanguage,
  });
  const { namespace } = await application.import();

  t.true(spy.sawRawTypeScript, 'explicit cts parser received raw TypeScript');
  t.is(namespace.default, 42);
});

const unsupportedFixture = new URL(
  './fixtures/typescript-archive-unsupported/main.js',
  import.meta.url,
).href;

test('CLI source archives locate unsupported TypeScript syntax', async t => {
  const error = await t.throwsAsync(makeCliArchive(unsupportedFixture));
  t.regex(error.message, /unsupported\.ts/);
  t.regex(error.message, /enum/i);
});
