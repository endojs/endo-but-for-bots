import test from 'ava';
import { whereEndoGatewayRegistrarSock } from '../index.js';

test('env override', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('linux', {
      ENDO_GATEWAY_REGISTRAR_SOCK: '/tmp/gateway/registrar.sock',
    }),
    '/tmp/gateway/registrar.sock',
    'ENDO_GATEWAY_REGISTRAR_SOCK overrides the default on every platform',
  );
});

test('windows', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('win32', {}),
    '\\\\.\\pipe\\endo-gateway\\registrar',
    'Use a named pipe for the registrar channel on Windows',
  );
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('win32', {
      PROGRAMDATA: 'C:\\ProgramData',
    }),
    '\\\\.\\pipe\\endo-gateway\\registrar',
    'Named pipe on Windows is independent of PROGRAMDATA',
  );
});

test('darwin', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('darwin', {}),
    '/var/run/endo-gateway/registrar.sock',
    'Place the registrar socket under the runtime directory on Darwin',
  );
});

test('linux', t => {
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('linux', {}),
    '/run/endo-gateway/registrar.sock',
    'Place the registrar socket under the runtime directory on Linux',
  );
});

test('inherits ENDO_GATEWAY_EPHEMERAL_STATE on POSIX when registrar override is unset', t => {
  // The registrar socket on POSIX is sited under the gateway's ephemeral
  // state directory, so overriding ENDO_GATEWAY_EPHEMERAL_STATE must
  // relocate the registrar socket alongside it.
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('linux', {
      ENDO_GATEWAY_EPHEMERAL_STATE: '/tmp/endo-gateway-run',
    }),
    '/tmp/endo-gateway-run/registrar.sock',
    'Compose ENDO_GATEWAY_EPHEMERAL_STATE into the registrar socket path on Linux',
  );
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('darwin', {
      ENDO_GATEWAY_EPHEMERAL_STATE: '/tmp/endo-gateway-run',
    }),
    '/tmp/endo-gateway-run/registrar.sock',
    'Compose ENDO_GATEWAY_EPHEMERAL_STATE into the registrar socket path on Darwin',
  );
});

test('ENDO_GATEWAY_REGISTRAR_SOCK wins over ENDO_GATEWAY_EPHEMERAL_STATE', t => {
  // When both overrides are set, the more-specific registrar override
  // takes precedence, so an operator who places the registrar at a
  // bespoke path is not surprised by ephemeral-state composition.
  t.is(
    // @ts-expect-error Expected 3 arguments, but got 2.
    whereEndoGatewayRegistrarSock('linux', {
      ENDO_GATEWAY_REGISTRAR_SOCK: '/run/bespoke/registrar.sock',
      ENDO_GATEWAY_EPHEMERAL_STATE: '/tmp/endo-gateway-run',
    }),
    '/run/bespoke/registrar.sock',
    'The registrar-specific override wins over the broader ephemeral-state override',
  );
});
