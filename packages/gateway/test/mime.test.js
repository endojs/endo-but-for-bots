// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  inferContentType,
  extensionOf,
  DEFAULT_CONTENT_TYPE,
} from '../index.js';

test('extensionOf extracts a lowercase extension', t => {
  t.is(extensionOf('index.html'), 'html');
  t.is(extensionOf('App.JS'), 'js');
  t.is(extensionOf('archive.tar.gz'), 'gz');
});

test('extensionOf returns empty for no extension or a dotfile', t => {
  t.is(extensionOf('README'), '');
  t.is(extensionOf('.well-known'), '');
  t.is(extensionOf(''), '');
});

test('inferContentType maps known extensions', t => {
  t.is(inferContentType('index.html'), 'text/html; charset=utf-8');
  t.is(inferContentType('app.js'), 'text/javascript; charset=utf-8');
  t.is(inferContentType('style.css'), 'text/css; charset=utf-8');
  t.is(inferContentType('logo.svg'), 'image/svg+xml');
  t.is(inferContentType('font.woff2'), 'font/woff2');
  t.is(inferContentType('module.wasm'), 'application/wasm');
});

test('inferContentType falls back to octet-stream for unknown', t => {
  t.is(inferContentType('data.bin'), DEFAULT_CONTENT_TYPE);
  t.is(inferContentType('NOTICE'), DEFAULT_CONTENT_TYPE);
});

test('inferContentType honors overrides over the built-in table', t => {
  t.is(
    inferContentType('app.js', { js: 'application/javascript' }),
    'application/javascript',
  );
  // An override for an otherwise-unknown extension.
  t.is(
    inferContentType('data.bin', { bin: 'application/x-thing' }),
    'application/x-thing',
  );
  // An empty override string is ignored, falling back to inference.
  t.is(
    inferContentType('index.html', { html: '' }),
    'text/html; charset=utf-8',
  );
});
