import test from 'ava';
import { whereEndoGatewayCache } from '../index.js';

test('env override', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayCache('linux', {
      ENDO_GATEWAY_CACHE: '/srv/endo-gateway/cache',
    }),
    '/srv/endo-gateway/cache',
    'ENDO_GATEWAY_CACHE overrides the default on every platform',
  );
});

test('windows', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayCache('win32', {
      PROGRAMDATA: 'C:\\ProgramData',
    }),
    'C:\\ProgramData\\Endo Gateway\\Cache',
    'Use PROGRAMDATA\\Endo Gateway\\Cache on Windows',
  );
});

test('darwin', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayCache('darwin', {}),
    '/Library/Caches/Endo Gateway',
    'Use /Library/Caches at host scope on Darwin',
  );
});

test('linux', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayCache('linux', {}),
    '/var/cache/endo-gateway',
    'Use /var/cache for the Gateway cache on Linux',
  );
});
