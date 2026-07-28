// @ts-nocheck
/* global process */
// import "./ses-lockdown.js";
import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { setTimeout } from 'node:timers';
import { importLocation } from '../src/import.js';
import { makeReadPowers } from '../src/node-powers.js';

const readPowers = makeReadPowers({ fs, url });
const { read } = readPowers;

test('import mutability compared with node.js', async t => {
  // The fixture exercises CJS importing ESM via require(), which Node.js
  // only supports from 20.17 onward (require(esm), made default in 22.12
  // and backported to 20 LTS). Node 18 throws ERR_REQUIRE_ESM at fixture
  // load time, before any compartment-mapper behaviour can be observed.
  // Skip rather than pin a Node-18-specific snapshot, since the test's
  // entire purpose is parity comparison with Node's own behaviour.
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    t.pass('Skipping: Node < 20 cannot require() an ES module');
    return;
  }

  t.plan(1);

  const fixture = new URL(
    'fixtures-import-mutability/index.js',
    import.meta.url,
  ).toString();

  const result = await import(fixture);

  const { namespace } = await importLocation(read, fixture, {
    globals: {
      console,
      setTimeout,
    },
  });

  const compare = {
    node: await result.getSummary(),
    ses: await namespace.getSummary(),
  };
  const differences = Object.entries(compare.node).map(([key, value]) => {
    if (value !== compare.ses[key]) {
      return `[!] ${key}: node=${value} endo=${compare.ses[key]} `;
    } else {
      return `    ${key}: both ${value}`;
    }
  });
  t.log(differences.join('\n'));
  t.snapshot(differences);
});
