/* eslint-env node */
// Serve the chat package for the daemon-free e2e harness pages under
// test/e2e/harness/. Like test/inventory-item-actions/run.mjs, this is a bare
// Vite server without the Endo daemon plugin; it keeps the `node:crypto`
// alias from vite.config.js so the shared modules resolve as in the app.
//
//   node test/e2e/harness/serve.mjs   (started by playwright.harness.config.ts)

import { fileURLToPath } from 'url';
// eslint-disable-next-line import/no-unresolved
import { createServer } from 'vite';

const port = Number(process.env.HARNESS_PORT || 5210);

const server = await createServer({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  configFile: false,
  logLevel: 'warn',
  resolve: {
    alias: {
      'node:crypto': fileURLToPath(
        new URL('../../../node-crypto-shim.js', import.meta.url),
      ),
    },
  },
  server: { port, strictPort: true },
});
await server.listen();
server.printUrls();
