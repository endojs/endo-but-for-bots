#!/usr/bin/env node
// @ts-check

import { main } from '@earendil-works/pi-coding-agent';

import { argv } from 'node:process';

import { makeEndoCodeModePiExtension } from '../endo-code-mode-pi-extension.js';

await main(argv.slice(2), {
  extensionFactories: [
    {
      name: '@endo/agentry/endo-code-mode-pi-extension',
      factory: makeEndoCodeModePiExtension(),
    },
  ],
});
