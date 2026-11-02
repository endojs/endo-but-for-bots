// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeSubagentAdmission } from '../src/subagent-admission.js';

test('reservations count unpublished work once, isolate roots, and recover after failure', t => {
  const sessions = [{ id: 'root' }, { id: 'other' }];
  const admission = makeSubagentAdmission({
    getSessions: () => sessions,
    maxSubagents: 2,
    maxDepth: 3,
  });
  const first = admission.reserve('root', 'a', 1);
  sessions.push({ id: 'child', parentSessionId: 'root', subagentName: 'a' });
  const second = admission.reserve('child', 'b', 2);
  t.throws(() => admission.reserve('root', 'c', 1), { message: /tree limit/ });
  const other = admission.reserve('other', 'a', 1);
  other.release();
  second.release(); // failed provisioning before registry publication
  const recovered = admission.reserve('child', 'b', 2);
  recovered.release();
  first.release();
  const restored = makeSubagentAdmission({
    getSessions: () => sessions,
    maxSubagents: 1,
    maxDepth: 3,
  });
  t.throws(() => restored.reserve('child', 'b', 2), { message: /tree limit/ });
});

test('depth is checked at admission and deleting ancestors fence descendants', async t => {
  t.timeout(5000);
  const sessions = [
    { id: 'root', lifecycle: 'ready' },
    { id: 'child', parentSessionId: 'root', subagentName: 'a' },
  ];
  const admission = makeSubagentAdmission({
    getSessions: () => sessions,
    maxSubagents: 8,
    maxDepth: 2,
  });
  t.throws(() => admission.reserve('child', 'bad', 1), {
    message: /depth limit/,
  });
  const reservation = admission.reserve('child', 'b', 2);
  sessions[0].lifecycle = 'deleting';
  t.throws(reservation.assertParent, { message: /no longer accepts/ });
  t.throws(() => admission.reserve('child', 'c', 2), {
    message: /no longer accepts/,
  });
  const draining = admission.waitForChildren('child');
  reservation.release();
  await draining;
  t.pass();
});

test('retained cleanup failures and legacy duplicate names still consume the tree budget', t => {
  const sessions = [
    { id: 'root' },
    {
      id: 'a',
      parentSessionId: 'root',
      subagentName: 'duplicate',
      lifecycle: 'error',
    },
    { id: 'b', parentSessionId: 'root', subagentName: 'duplicate' },
  ];
  const admission = makeSubagentAdmission({
    getSessions: () => sessions,
    maxSubagents: 2,
    maxDepth: 2,
  });
  t.throws(() => admission.reserve('root', 'third', 1), {
    message: /tree limit/,
  });
  sessions.splice(1, 1);
  admission.reserve('root', 'third', 1).release();
});
