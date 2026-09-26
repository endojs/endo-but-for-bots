// @ts-check
import test from '@endo/ses-ava/test.js';

import { makeLogPowers, silentLogger } from '../src/platform/logging.js';

/** Collect the three channels of a logger separately. */
const makeSpy = () => {
  /** @type {{ log: unknown[][], info: unknown[][], error: unknown[][] }} */
  const lines = { log: [], info: [], error: [] };
  const logging = makeLogPowers({
    log: (...args) => lines.log.push(args),
    info: (...args) => lines.info.push(args),
    error: (...args) => lines.error.push(args),
  });
  return { lines, logging };
};

test('a root logger writes each level through unprefixed', t => {
  const { lines, logging } = makeSpy();
  t.deepEqual([...logging.path], []);
  logging.log('a');
  logging.info('b');
  logging.error('c');
  t.deepEqual(lines, { log: [['a']], info: [['b']], error: [['c']] });
});

test('sub extends the path and prepends it as one token', t => {
  const { lines, logging } = makeSpy();
  const worker = logging.sub('thixotrope', 'daemon').sub('worker');
  t.deepEqual([...worker.path], ['thixotrope', 'daemon', 'worker']);
  worker.error('halted', 7);
  t.deepEqual(lines.error, [['[thixotrope:daemon:worker]', 'halted', 7]]);
  // The parent keeps its own path.
  logging.error('root');
  t.deepEqual(lines.error[1], ['root']);
});

test('a host can merge the trace channel into its error channel', t => {
  /** @type {unknown[][]} */
  const errors = [];
  const error = (...args) => errors.push(args);
  const logging = makeLogPowers({
    log: () => t.fail('log should not receive info'),
    info: error,
    error,
  });
  logging.sub('peer').info('noticed');
  t.deepEqual(errors, [['[peer]', 'noticed']]);
});

test('silentLogger discards every level, including through sub', t => {
  t.notThrows(() => {
    silentLogger.log('a');
    silentLogger.info('b');
    silentLogger.error('c');
    silentLogger.sub('x').error('d');
  });
});
