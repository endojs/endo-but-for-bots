import test from 'ava';
import { whereEndoGatewayEphemeralState } from '../index.js';

test('env override', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayEphemeralState('linux', {
      ENDO_GATEWAY_EPHEMERAL_STATE: '/tmp/endo-gateway-run',
    }),
    '/tmp/endo-gateway-run',
    'ENDO_GATEWAY_EPHEMERAL_STATE overrides the default on every platform',
  );
});

test('windows', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayEphemeralState('win32', {
      PROGRAMDATA: 'C:\\ProgramData',
    }),
    'C:\\ProgramData\\Endo Gateway\\Run',
    'Use PROGRAMDATA\\Endo Gateway\\Run for ephemeral state on Windows',
  );
  t.is(
    whereEndoGatewayEphemeralState(
      'win32',
      {},
      {
        home: 'C:\\Users\\Bill',
      },
    ),
    'C:\\Users\\Bill\\..\\..\\ProgramData\\Endo Gateway\\Run',
    'Fall back to a path relative to home when PROGRAMDATA is unset',
  );
});

test('darwin', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayEphemeralState('darwin', {}),
    '/var/run/endo-gateway',
    'Use /var/run for the Gateway runtime directory on Darwin',
  );
});

test('linux', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayEphemeralState('linux', {}),
    '/run/endo-gateway',
    'Use /run for the Gateway runtime directory on Linux (systemd convention)',
  );
});
