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
