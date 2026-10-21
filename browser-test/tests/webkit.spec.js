// @ts-check
/* global globalThis */
// eslint-disable-next-line import/no-extraneous-dependencies
const { test, expect } = require('@playwright/test');

test.describe('WebKit probe', () => {
  test.skip(({ browserName }) => browserName !== 'webkit');

  test('lockdown and selected pure-JavaScript package behavior', async ({
    page,
    browser,
  }) => {
    console.log(`WebKit ${browser.version()}`);

    page.on('console', message =>
      console.log(`> Log in page: ${message.text()}`),
    );
    page.on('pageerror', error => {
      console.error(`> Error in page: ${error.message}\n${error.stack}`);
    });

    await page.goto('http://127.0.0.1:3000/');
    const result = await page.evaluate(async () => {
      'use strict';

      const webGlobals = /** @type {any} */ (globalThis);
      const { lockdown, Compartment } = webGlobals;
      const importModule = /** @type {(url: string) => Promise<any>} */ (
        url => import(url)
      );

      const hostDescriptors = {
        urlSearchParamsLength: Object.getOwnPropertyDescriptor(
          URLSearchParams.prototype,
          'length',
        ),
        textEncoderTag: Object.getOwnPropertyDescriptor(
          TextEncoder.prototype,
          Symbol.toStringTag,
        ),
        textDecoderTag: Object.getOwnPropertyDescriptor(
          TextDecoder.prototype,
          Symbol.toStringTag,
        ),
      };

      lockdown();

      const { encodeBase64, decodeBase64 } = await importModule(
        '/packages/base64/index.js',
      );
      const { makeCacheMapKit } = await importModule(
        '/packages/cache-map/index.js',
      );
      const { pathCompare } = await importModule(
        '/packages/path-compare/index.js',
      );

      const textEncoder = new TextEncoder();
      const textDecoder = new TextDecoder();
      const base64Vectors = [
        ['', ''],
        ['f', 'Zg=='],
        ['fo', 'Zm8='],
        ['foo', 'Zm9v'],
        ['foobar', 'Zm9vYmFy'],
      ];
      const base64Results = base64Vectors.map(([plain, encoded]) => ({
        encoded: encodeBase64(textEncoder.encode(plain)),
        decoded: textDecoder.decode(decodeBase64(encoded)),
      }));

      const { cache, getMetrics } = makeCacheMapKit(2, { makeMap: Map });
      cache.set('first', 1);
      cache.set('second', 2);
      cache.get('first');
      cache.set('third', 3);

      const compartment = new Compartment();
      compartment.evaluate('globalThis.probe = 1');

      return {
        hostDescriptors,
        base64Results,
        cache: {
          first: cache.get('first'),
          second: cache.get('second'),
          third: cache.get('third'),
          metrics: getMetrics(),
        },
        pathComparisons: [
          pathCompare(['a'], ['a', 'b']),
          pathCompare(['a', 'b'], ['aa', 'bb']),
          pathCompare(['a', 'b'], ['a', 'c']),
          pathCompare(undefined, ['a']),
        ],
        compartmentProbe: compartment.evaluate('probe'),
        hostProbe: webGlobals.probe,
      };
    });

    expect(result.hostDescriptors).toEqual({
      urlSearchParamsLength: undefined,
      textEncoderTag: {
        value: 'TextEncoder',
        writable: false,
        enumerable: false,
        configurable: true,
      },
      textDecoderTag: {
        value: 'TextDecoder',
        writable: false,
        enumerable: false,
        configurable: true,
      },
    });
    expect(result.base64Results).toEqual([
      { encoded: '', decoded: '' },
      { encoded: 'Zg==', decoded: 'f' },
      { encoded: 'Zm8=', decoded: 'fo' },
      { encoded: 'Zm9v', decoded: 'foo' },
      { encoded: 'Zm9vYmFy', decoded: 'foobar' },
    ]);
    expect(result.cache).toEqual({
      first: 1,
      second: undefined,
      third: 3,
      metrics: { totalQueryCount: 7, totalHitCount: 3 },
    });
    expect(result.pathComparisons).toEqual([-1, -2, -1, 1]);
    expect(result.compartmentProbe).toBe(1);
    expect(result.hostProbe).toBeUndefined();
  });

  test('does not expose JavaScript coverage', async ({ page }) => {
    await expect(page.coverage.startJSCoverage()).rejects.toThrow(
      /Cannot read properties of null/,
    );
  });
});
