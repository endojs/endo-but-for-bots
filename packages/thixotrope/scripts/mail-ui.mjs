// @ts-check
import '@endo/init';
import { makeBundle } from '@endo/compartment-mapper/bundle.js';
import { makeReadPowers } from '@endo/compartment-mapper/node-powers.js';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
import { parseArgs } from 'node:util';

import { connectLocalControl } from '../src/control/local-control.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { serveMailUi } from '../src/platform/node/mail-ui-server.js';
import { makeMailUiService } from '../src/web/mail-ui-service.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', default: 'default' },
    port: { type: 'string', default: '8123' },
  },
});
const [state, ...keys] = positionals;
const port = Number(values.port);
if (!state || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw Error(
    'Usage: yarn workspace @endo/thixotrope mail-ui [--workspace NAME] [--port 8123] STATE [INVENTORY_KEY ...]',
  );
}
const readPowers = makeReadPowers({ fs, crypto, path, url });
const [hostBuild, component] = await Promise.all([
  build({
    entryPoints: [
      url.fileURLToPath(
        new URL('../src/platform/browser/mail-ui-host.js', import.meta.url),
      ),
    ],
    banner: { js: '"use strict";' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  }),
  makeBundle(
    readPowers,
    new URL('../src/web/mail-ui.js', import.meta.url).href,
  ),
]);
const host = hostBuild.outputFiles[0].text;
const css = await fs.promises.readFile(
  new URL('../src/web/mail-ui.css', import.meta.url),
  'utf8',
);
const assets = new Map([
  [
    '/',
    {
      type: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail · Thixotrope</title><link rel="stylesheet" href="/mail.css"><script src="/host.js" defer></script></head><body><div id="root"><p>Opening mail…</p></div></body></html>',
    },
  ],
  ['/host.js', { type: 'text/javascript; charset=utf-8', body: host }],
  [
    '/component.js',
    { type: 'text/javascript; charset=utf-8', body: component },
  ],
  ['/mail.css', { type: 'text/css; charset=utf-8', body: css }],
]);
const client = await connectLocalControl(
  makeNodePowers(),
  path.join(path.resolve(state), 'control.sock'),
  { workspace: values.workspace },
);
try {
  const book = await client.call('getAddressBook');
  const attachments = new Map();
  for (const key of new Set(keys))
    attachments.set(key, await client.call('lookup', key));
  const service = makeMailUiService({
    book,
    mailbox: await client.call('lookup', 'mailbox'),
    contacts: await client.call('lookup', 'contacts'),
    inventory: await client.call('getInventory'),
    workspace: values.workspace,
    attachments,
    adoptValue: (name, value) => client.call('adopt', name, value),
  });
  const mail = harden({
    snapshot: () => client.race(service.snapshot()),
    subscribe: (onState, onError) =>
      client.race(service.subscribe(onState, onError)),
    adopt: (token, name) => client.race(service.adopt(token, name)),
    send: (recipient, content) => client.race(service.send(recipient, content)),
  });
  const server = await serveMailUi({
    mail,
    assets,
    port,
    token: await client.call('getMailUiToken'),
  });
  console.error(`Mail (${values.workspace}): ${server.url}`);
  console.error(
    'Keep this private URL. Ctrl-C closes the browser bridge; the daemon keeps running.',
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    client.close();
  };
  process.once('SIGINT', () => {
    void close();
  });
  process.once('SIGTERM', () => {
    void close();
  });
  void client.closed.then(close);
} catch (error) {
  client.close();
  throw error;
}
