import test from 'ava';
import { whereEndoGatewayState } from '../index.js';

test('env override', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayState('linux', {
      ENDO_GATEWAY_STATE: '/srv/endo-gateway',
    }),
    '/srv/endo-gateway',
    'ENDO_GATEWAY_STATE overrides the default on every platform',
  );
});

test('windows', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayState('win32', {
      PROGRAMDATA: 'C:\\ProgramData',
    }),
    'C:\\ProgramData\\Endo Gateway',
    'Use PROGRAMDATA for Endo Gateway state on Windows',
  );
  t.is(
    whereEndoGatewayState(
      'win32',
      {},
      {
        home: 'C:\\Users\\Bill',
      },
    ),
    'C:\\Users\\Bill\\..\\..\\ProgramData\\Endo Gateway',
    'Fall back to a path relative to home when PROGRAMDATA is unset',
  );
});

test('darwin', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayState('darwin', {}),
    '/Library/Application Support/Endo Gateway',
    'Use the host-wide Library directory on Darwin',
  );
});

test('linux', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayState('linux', {}),
    '/var/lib/endo-gateway',
    'Use /var/lib for the Gateway service-account-owned state on Linux',
  );
});
