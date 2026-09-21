// @ts-check

import '@endo/init';

import { access } from 'node:fs/promises';
import net from 'node:net';

import { makeCancelKit } from '@endo/cancel';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeSocketPowers } from '../src/manager-node-powers.js';

const [, , activatedSocketPath] = process.argv;
if (activatedSocketPath === undefined) {
  throw new Error('Expected a socket path argument');
}
const unboundPath = `${activatedSocketPath}.unbound`;

const { cancelled, cancel } = makeCancelKit();
cancelled.catch(() => {});

const { servePath } = makeSocketPowers({ net, fsp: { access } });
const connections = await servePath({ path: unboundPath, cancelled });

if (process.env.LISTEN_PID !== undefined) {
  throw new Error('LISTEN_PID was not cleared');
}
if (process.env.LISTEN_FDS !== undefined) {
  throw new Error('LISTEN_FDS was not cleared');
}

process.stdout.write('ready\n');
const { value: connection } = await connections.next();
if (connection === undefined) {
  throw new Error('Inherited listener ended before accepting a connection');
}
await connection.writer.next(encodeUtf8('accepted\n'));
await connection.writer.return();

cancel(new Error('test complete'));
await connections.next().catch(() => {});
