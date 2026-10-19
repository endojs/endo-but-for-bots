#!/usr/bin/env node
// @ts-check
/* global process */
// spell-out-exempt: `temp` is the @endo/where platform-info field name.
import '@endo/init';

import fs from 'node:fs';
import os from 'node:os';

import { mainHttp } from '../src/http.js';
import { connectToDaemon } from '../src/server.js';

const { version } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);
const { username, homedir } = os.userInfo();

const stop = new Promise(resolve => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

mainHttp({
  env: process.env,
  connect: () =>
    connectToDaemon({
      env: process.env,
      platform: process.platform,
      info: { user: username, home: homedir, temp: os.tmpdir() },
    }),
  log: line => process.stderr.write(`${line}\n`),
  version,
  stop,
}).then(
  code => process.exit(code),
  error => {
    process.stderr.write(`${String(error)}\n`, () => process.exit(1));
  },
);
