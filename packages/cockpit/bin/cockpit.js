#!/usr/bin/env node
// @ts-check
//
// Start the garden cockpit harness-host. Defaults to the mock engine, so it
// runs with no LLM and no monorepo install: open the printed URL and ask the
// tracer thread "what branch?".

import { makeCockpit, buildMockCaps } from '../src/index.js';
import { makeCockpitServer } from '../src/backend/server.js';

const cockpit = makeCockpit();

// M0 tracer: one thread over a read-only git cap.
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
