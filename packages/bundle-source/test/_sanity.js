// @ts-check
import { lockdown } from '@endo/lockdown';

import url from 'url';
import test from 'ava';

function evaluate(src, endowments) {
  const c = new Compartment(endowments, {}, {});
  return c.evaluate(src);
}

export async function makeSanityTests(stackFiltering) {
  // Lock down before importing modules that call `harden` at module
  // top level (notably `@endo/base64`, which is hardened so its
  // exports cannot be tampered with).  Loading those statically would
  // install `@endo/harden`'s fallback before this lockdown call and
  // break it.
  lockdown({ errorTaming: 'unsafe', stackFiltering });
  Error.stackTraceLimit = Infinity;

  const { decodeBase64 } = await import('@endo/base64');
  const { parseArchive } = await import(
    '@endo/compartment-mapper/import-archive.js'
  );
  const { default: bundleSource } = await import('../src/index.js');

  const prefix = stackFiltering === 'concise' ? '' : '/bundled-source/.../';

  /**
   * @param {string[]} stack
   * @param {string} filePattern
   */
  function stackContains(stack, filePattern) {
    return stack.indexOf(`${prefix}${filePattern}`) >= 0;
  }

  test(`endoZipBase64`, async t => {
    const { endoZipBase64 } = await bundleSource(
      url.fileURLToPath(new URL('../demo/dir1/encourage.js', import.meta.url)),
      'endoZipBase64',
    );

    const bytes = decodeBase64(endoZipBase64);
    const archive = await parseArchive(bytes);
    // Call import by property to bypass SES censoring for dynamic import.
    // eslint-disable-next-line dot-notation
    const { namespace } = await archive['import']();
    const { message, encourage } = namespace;

    t.is(message, `You're great!`);
    t.is(encourage('you'), `Hey you!  You're great!`);
  });

  test(`nestedEvaluate`, async t => {
    const {
      moduleFormat: mf1,
      source: src1,
      sourceMap: map1,
    } = await bundleSource(
      url.fileURLToPath(new URL(`../demo/dir1`, import.meta.url)),
      'nestedEvaluate',
    );

    const srcMap1 = `(${src1})\n${map1}`;

    // console.log(srcMap1);

    t.is(mf1, 'nestedEvaluate', 'module format is nestedEvaluate');

    const nestedEvaluate = src => {
      // console.log('========== evaluating', src);
      return evaluate(src, { nestedEvaluate });
    };
    const ex1 = nestedEvaluate(srcMap1)();

    const bundle = ex1.default();
    const err = bundle.makeError('foo');
    // t.log(err.stack);
    t.assert(
      stackContains(err.stack, 'bundle-source/demo/dir1/encourage.js:2:'),
      'bundled source is in stack trace with correct line number',
    );

    const err2 = bundle.makeError2('bar');
    // t.log(err2.stack);
    t.assert(
      stackContains(err2.stack, 'bundle-source/demo/dir1/index.js:8:'),
      'bundled source is in second stack trace with correct line number',
    );

    const {
      moduleFormat: mf2,
      source: src2,
      sourceMap: map2,
    } = await bundleSource(
      url.fileURLToPath(new URL(`../demo/dir1/encourage.js`, import.meta.url)),
      'nestedEvaluate',
    );
    t.is(mf2, 'nestedEvaluate', 'module format 2 is nestedEvaluate');

    const srcMap2 = `(${src2})\n${map2}`;

    const ex2 = nestedEvaluate(srcMap2)();
    t.is(ex2.message, `You're great!`, 'exported message matches');
    t.is(
      ex2.encourage('Nick'),
      `Hey Nick!  You're great!`,
      'exported encourage matches',
    );
  });

  test(`getExport`, async t => {
    const {
      moduleFormat: mf1,
      source: src1,
      sourceMap: map1,
    } = await bundleSource(
      url.fileURLToPath(new URL(`../demo/dir1`, import.meta.url)),
      'getExport',
    );

    const srcMap1 = `(${src1})\n${map1}`;

    // console.log(srcMap1);

    t.is(mf1, 'getExport', 'module format is getExport');

    // eslint-disable-next-line no-eval
    const ex1 = eval(`${srcMap1}`)();

    const bundle = ex1.default();
    const err = bundle.makeError('foo');
    t.assert(
      !stackContains(err.stack, 'encourage.js:'),
      'bundled source is not in stack trace',
    );

    const {
      moduleFormat: mf2,
      source: src2,
      sourceMap: map2,
    } = await bundleSource(
      url.fileURLToPath(new URL(`../demo/dir1/encourage.js`, import.meta.url)),
      'nestedEvaluate',
    );
    t.is(mf2, 'nestedEvaluate', 'module format 2 is nestedEvaluate');

    const srcMap2 = `(${src2})\n${map2}`;

    // eslint-disable-next-line no-eval
    const eval2 = eval;
    const ex2 = eval2(srcMap2)();
    t.is(ex2.message, `You're great!`, 'exported message matches');
    t.is(
      ex2.encourage('Nick'),
      `Hey Nick!  You're great!`,
      'exported encourage matches',
    );
  });

  test('babel-parser types', async t => {
    // Once upon a time, bundleSource mangled:
    //   function createBinop(name, binop) {
    //     return new TokenType(name, {
    //       beforeExpr,
    //       binop
    //     });
    //   }
    // into:
    //  function createBinop(name, binop) {  return new TokenType(name, {    beforeExpr,;    binop });};
    //
    // Make sure it's ok now. The function in question came
    // from @agoric/babel-parser/lib/tokenizer/types.js

    const { source: src1 } = await bundleSource(
      url.fileURLToPath(
        new URL(`../demo/babel-parser-mangling.js`, import.meta.url),
      ),
      'getExport',
    );

    t.truthy(!src1.match(/beforeExpr,;/), 'source is not mangled that one way');
    // the mangled form wasn't syntactically valid, do a quick check
    // eslint-disable-next-line no-eval
    const eval2 = eval;
    eval2(`(${src1})`);
  });
}
