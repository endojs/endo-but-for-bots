#!/usr/bin/env node
// @ts-check
/* global process */

import '@endo/init';

import Database from 'better-sqlite3';
import { startRegistryServer } from '../src/server.js';
import {
  installPublisherGrant,
  readPublisherGrantEnv,
  readServerEnv,
} from '../src/config.js';

const config = readServerEnv(process.env);
const grant = readPublisherGrantEnv(process.env);
// The bearer leaves the environment once its hash is durable.
delete process.env.REGISTRY_PUBLISHER_TOKEN;

const running = await startRegistryServer({
  ...config,
  openDatabase: file => new Database(file),
  log: entry => console.log(JSON.stringify(entry)),
});
if (grant) {
  installPublisherGrant(running.grants, grant, console.error);
}
console.log(
  JSON.stringify({
    event: 'listening',
    url: running.url,
    publicOrigin: config.publicOrigin,
    upstreamOrigin: config.upstreamOrigin ?? null,
  }),
);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await running.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
