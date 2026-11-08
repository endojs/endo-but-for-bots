// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { makePromiseKit } from '@endo/promise-kit';
import { makeFlootHistoryPages } from '../floot-history-pages.js';

test('a fresh snapshot fences an in-flight older page and accepts an independent cursor', async t => {
  const old = makePromiseKit();
  const idle = makePromiseKit();
  const published = [];
  const calls = [];
  const turn = id => ({ id, messages: [{ role: 'assistant', content: id }] });
  const model = makeFlootHistoryPages(
    async before => {
      calls.push(before);
      if (before === '9') return old.promise;
      return { turns: [turn('10')], before: null };
    },
    (messages, more, loading) => {
      published.push(messages.map(m => m.content));
      if (!loading && !more) idle.resolve(undefined);
    },
    error => t.fail(String(error)),
  );
  model.setLatest([turn('9')], '9', true);
  model.more();
  model.setLatest([turn('11')], '11', true);
  old.reject(Error('connection lost'));
  await new Promise(resolve => setImmediate(resolve));
  model.more();
  await idle.promise;
  t.deepEqual(calls, ['9', '11']);
  t.deepEqual(published.at(-1), ['10', '11']);
  t.false(published.some(rows => rows.includes('9') && rows.includes('11')));
});
