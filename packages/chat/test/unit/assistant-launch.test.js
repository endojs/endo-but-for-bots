// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { claimAssistantInvocation } from '../../assistant-launch.js';
import { makeTestLocks } from '../helpers/web-locks.js';

test('assistant launch claims survive remounts, serialize duplicate delivery and stay bounded', async t => {
  t.timeout(5000);
  const data = new Map();
  const storage = /** @type {Storage} */ (
    /** @type {unknown} */ ({
      getItem: key => data.get(key) || null,
      setItem: (key, value) => data.set(key, value),
    })
  );
  const locks = /** @type {LockManager} */ (
    /** @type {unknown} */ (makeTestLocks())
  );
  t.deepEqual(
    await Promise.all([
      claimAssistantInvocation(storage, locks, 'same'),
      claimAssistantInvocation(storage, locks, 'same'),
    ]),
    [true, false],
  );
  t.false(await claimAssistantInvocation(storage, locks, 'same'));
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await claimAssistantInvocation(storage, locks, `next-${i}`);
  }
  t.is(data.size, 1);
  t.is(JSON.parse(data.get('floot-assistant-launch')).length, 32);
});
