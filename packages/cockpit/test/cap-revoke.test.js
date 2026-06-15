// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCockpit } from '../src/index.js';
import { makeMessageHandler } from '../src/backend/server.js';

/** @import { ThreadEvent } from '../src/backend/engine.js' */

/** @param {unknown} data */
const wasPushed = data =>
  Boolean(/** @type {{ pushed?: boolean }} */ (data)?.pushed);

const setup = () => {
  const cockpit = makeCockpit();
  /** @type {Array<{ threadId: string, ev: ThreadEvent }>} */
  const events = [];
  cockpit.onEvent((threadId, ev) => events.push({ threadId, ev }));
  const handler = makeMessageHandler(
    cockpit,
    () => {},
    () => {},
  );
  return { cockpit, events, handler };
};

test('the M2 demo: revoke a cap and the agent is literally unable to act', async t => {
  const { cockpit, events, handler } = setup();
  await handler(
    JSON.stringify({
      type: 'new-thread',
      caps: [{ name: 'git', kind: 'git', mode: 'readWrite' }],
    }),
  );
  const id = cockpit.registry.ids()[0];

  // push works while the cap is held
  await handler(JSON.stringify({ type: 'steer', threadId: id, text: 'push' }));
  t.true(
    events.some(
      e =>
        e.threadId === id &&
        e.ev.kind === 'tool-result' &&
        wasPushed(e.ev.data),
    ),
    'push should succeed with a read-write git cap',
  );

  // revoke git; the next push fails because the object left the scope
  events.length = 0;
  await handler(
    JSON.stringify({ type: 'revoke-cap', threadId: id, capName: 'git' }),
  );
  await handler(JSON.stringify({ type: 'steer', threadId: id, text: 'push' }));
  t.true(
    events.some(
      e =>
        e.threadId === id &&
        e.ev.kind === 'error' &&
        /no git capability in scope/.test(String(e.ev.message)),
    ),
    'push should fail after the git cap is revoked',
  );

  // grant it back; push works again
  events.length = 0;
  await handler(
    JSON.stringify({
      type: 'grant-cap',
      threadId: id,
      cap: { name: 'git', kind: 'git', mode: 'readWrite' },
    }),
  );
  await handler(JSON.stringify({ type: 'steer', threadId: id, text: 'push' }));
  t.true(
    events.some(
      e =>
        e.threadId === id &&
        e.ev.kind === 'tool-result' &&
        wasPushed(e.ev.data),
    ),
    'push should succeed again after the cap is granted back',
  );
});
