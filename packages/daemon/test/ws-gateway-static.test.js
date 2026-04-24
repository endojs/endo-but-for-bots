// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { startWsGateway } from '../src/ws-gateway.js';

/**
 * @param {string} url
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
const httpGet = url =>
  new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: /** @type {number} */ (res.statusCode),
          headers: res.headers,
          body,
        });
      });
      res.on('error', reject);
    });
  });

/**
 * Create a temp directory with test files and start a gateway serving them.
 *
 * @param {import('ava').ExecutionContext} t
 */
const setupStaticGateway = async t => {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-gw-test-'),
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'index.html'),
    '<html><body>Hello</body></html>',
    'utf-8',
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'app.js'),
    'console.log("app")',
    'utf-8',
  );
  await fs.promises.writeFile(
    path.join(tmpDir, 'style.css'),
    'body { color: red; }',
    'utf-8',
  );
  await fs.promises.mkdir(path.join(tmpDir, 'sub'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tmpDir, 'sub', 'page.html'),
    '<html>sub</html>',
    'utf-8',
  );

  const { promise: cancelled, reject: cancel } =
    /** @type {import('@endo/promise-kit').PromiseKit<never>} */ (
      makePromiseKit()
    );

  const mockBootstrap = Far('MockBootstrap', {
    gateway: () => Far('MockGateway', { fetch: () => undefined }),
  });

  const { started, stopped } = startWsGateway({
    endoBootstrap: mockBootstrap,
    host: '127.0.0.1',
    port: 0,
    cancelled,
    staticDir: tmpDir,
  });

  const address = await started;
  const url = new URL(address);
  const baseUrl = `http://127.0.0.1:${url.port}`;

  t.teardown(async () => {
    cancel(new Error('test done'));
    await stopped.catch(() => {});
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  return { baseUrl, tmpDir };
};

test.serial('serves index.html at root', async t => {
  const { baseUrl } = await setupStaticGateway(t);
  const res = await httpGet(`${baseUrl}/`);
  t.is(res.status, 200);
  t.true(res.headers['content-type']?.includes('text/html'));
  t.true(res.body.includes('Hello'));
});

test.serial('serves JS file with correct MIME type', async t => {
  const { baseUrl } = await setupStaticGateway(t);
  const res = await httpGet(`${baseUrl}/app.js`);
  t.is(res.status, 200);
  t.true(res.headers['content-type']?.includes('javascript'));
  t.is(res.body, 'console.log("app")');
});

test.serial('serves CSS file with correct MIME type', async t => {
  const { baseUrl } = await setupStaticGateway(t);
  const res = await httpGet(`${baseUrl}/style.css`);
  t.is(res.status, 200);
  t.true(res.headers['content-type']?.includes('text/css'));
});

test.serial('serves files in subdirectories', async t => {
  const { baseUrl } = await setupStaticGateway(t);
  const res = await httpGet(`${baseUrl}/sub/page.html`);
  t.is(res.status, 200);
  t.true(res.body.includes('sub'));
});

test.serial('SPA fallback serves index.html for missing files', async t => {
  const { baseUrl } = await setupStaticGateway(t);
  const res = await httpGet(`${baseUrl}/nonexistent/route`);
  t.is(res.status, 200);
  t.true(res.body.includes('Hello'));
});

test.serial('returns 404 when no index.html and file missing', async t => {
  // Create a static dir with NO index.html
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'endo-gw-noindex-'),
  );
  await fs.promises.writeFile(path.join(tmpDir, 'exists.txt'), 'data', 'utf-8');

  const { promise: cancelled, reject: cancel } =
    /** @type {import('@endo/promise-kit').PromiseKit<never>} */ (
      makePromiseKit()
    );

  const mockBootstrap = Far('MockBootstrap', {
    gateway: () => Far('MockGateway', { fetch: () => undefined }),
  });

  const { started, stopped } = startWsGateway({
    endoBootstrap: mockBootstrap,
    host: '127.0.0.1',
    port: 0,
    cancelled,
    staticDir: tmpDir,
  });

  const address = await started;
  const url = new URL(address);
  const baseUrl = `http://127.0.0.1:${url.port}`;

  t.teardown(async () => {
    cancel(new Error('test done'));
    await stopped.catch(() => {});
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  // Request a missing file — SPA fallback will try index.html which also
  // doesn't exist, so it should return 404.
  const res = await httpGet(`${baseUrl}/missing`);
  t.is(res.status, 404);
  t.is(res.body, 'Not Found');
});

test.serial('without staticDir returns plain text', async t => {
  const { promise: cancelled, reject: cancel } =
    /** @type {import('@endo/promise-kit').PromiseKit<never>} */ (
      makePromiseKit()
    );

  const mockBootstrap = Far('MockBootstrap', {
    gateway: () => Far('MockGateway', { fetch: () => undefined }),
  });

  const { started, stopped } = startWsGateway({
    endoBootstrap: mockBootstrap,
    host: '127.0.0.1',
    port: 0,
    cancelled,
  });

  const address = await started;
  const url = new URL(address);
  const baseUrl = `http://127.0.0.1:${url.port}`;

  t.teardown(async () => {
    cancel(new Error('test done'));
    await stopped.catch(() => {});
  });

  const res = await httpGet(`${baseUrl}/`);
  t.is(res.status, 200);
  t.is(res.body, 'Endo Gateway');
});
