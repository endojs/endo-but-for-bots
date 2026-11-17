#!/usr/bin/env node
// @ts-check
/* global process */
// spell-out-exempt: `temp` is the @endo/where platform-info field name.
import '@endo/init';

import fs from 'node:fs';
import os from 'node:os';

import { main } from '../src/main.js';

const { version } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);
const { username, homedir } = os.userInfo();

main({
  env: process.env,
  platform: process.platform,
  info: { user: username, home: homedir, temp: os.tmpdir() },
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  version,
}).then(
  code => {
    // main settles only after its output has flushed.
    process.exit(code);
  },
  error => {
    // Exit only once the diagnostic has reached the pipe.
    process.stderr.write(
      `${JSON.stringify({ reason: 'internal-error', level: 'error', message: String(error) })}\n`,
      () => process.exit(1),
    );
  },
);
