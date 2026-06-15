#!/usr/bin/env node
// @ts-check
/* global process */
//
// Start the garden cockpit harness-host. It attaches to a running Endo daemon
// when one is reachable (ONLINE — real agentry threads against live powers) and
// otherwise falls back to the deterministic mock engine (OFFLINE — runs with no
// LLM and no daemon): open the printed URL and ask the tracer thread
// "what branch?".

import '@endo/init';

import { makeCockpit, buildMockCaps } from '../src/index.js';
import { makeCockpitServer } from '../src/backend/server.js';
import { connectDaemon } from '../src/backend/daemon.js';

// Attempt to attach to a daemon; a null result means OFFLINE (mock) mode.
const connection = await connectDaemon();

const cockpit = makeCockpit(
  connection
    ? { powers: connection.powers, sockPath: connection.sockPath }
    : {},
);

if (connection) {
  // eslint-disable-next-line no-console
  console.log(`garden cockpit ONLINE — daemon at ${connection.sockPath}`);
} else {
  // eslint-disable-next-line no-console
  console.log('garden cockpit OFFLINE — no daemon reachable; mock engine');
}

// M0 tracer: one thread over a read-only git cap (mock; works in both modes).
cockpit.registry.create({
  templateName: 'tracer',
  caps: buildMockCaps([{ name: 'git', kind: 'git', mode: 'readOnly' }]),
});

const server = makeCockpitServer(cockpit);
const port = Number(process.env.PORT || 7610);
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`garden cockpit on http://localhost:${port}`);
});

process.on('SIGINT', () => {
  if (connection) connection.close();
  process.exit(0);
});
