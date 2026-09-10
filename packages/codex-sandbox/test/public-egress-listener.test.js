// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';

import { makePublicEgressListener } from '../src/public-egress-listener.js';
import { makePublicEgress } from '../src/public-egress.js';

const future = () => {
  /** @type {(value:any)=>void} */
  let resolve = () => {
    throw Error('Future not initialized');
  };
  const promise = new Promise(yes => {
    resolve = yes;
  });
  return { promise, resolve };
};

const listener = async (t, endpoint, options = {}) => {
  t.timeout(3000);
  const server = await makePublicEgressListener({ endpoint, ...options });
  t.teardown(server.dispose);
  return server;
};

const exchange = async (t, url, bytes) => {
  const target = new URL(url);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  });
  t.teardown(() => socket.destroy());
  const chunks = [];
  return new Promise((resolve, reject) => {
    socket.on('data', chunk => chunks.push(chunk.toString('utf8')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(bytes));
    socket.once('close', () => resolve(chunks.join('')));
  });
};

test.serial(
  'HTTP forwarding rebuilds authority/framing and strips proxy and hop headers',
  async t => {
    const opens = [];
    const writes = [];
    const finished = future();
    let read = false;
    let closed = 0;
    let halfClosed = 0;
    const endpoint = Far('PublicEndpoint', {
      open(host, port) {
        opens.push({ host, port });
        return Far('Tunnel', {
          write: text => {
            writes.push(atob(text));
            if (atob(text) === '0\r\n\r\n') finished.resolve(undefined);
          },
          end: () => {
            halfClosed += 1;
          },
          async read() {
            await finished.promise;
            if (read) return null;
            read = true;
            return btoa(
              'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nOK',
            );
          },
          close: () => {
            closed += 1;
          },
        });
      },
    });
    const server = await listener(t, endpoint);
    const url = new URL(server.url);
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          method: 'POST',
          path: 'http://public.example/package?q=one',
          headers: {
            host: '169.254.169.254',
            'proxy-authorization': 'must-not-forward',
            connection: 'x-remove',
            'x-remove': 'remove-me',
            'x-keep': 'keep-me',
          },
        },
        incoming => {
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', text => {
            body += text;
          });
          incoming.on('end', () =>
            resolve({ status: incoming.statusCode, body }),
          );
        },
      );
      t.teardown(() => request.destroy());
      request.on('error', reject);
      request.end('payload');
    });
    t.deepEqual(response, { status: 200, body: 'OK' });
    t.is(halfClosed, 0, 'HTTP framing, not a TCP FIN, completes the request');
    t.deepEqual(opens, [{ host: 'public.example', port: 80 }]);
    const forwarded = writes.join('');
    t.regex(
      forwarded,
      /^POST \/package\?q=one HTTP\/1\.1\r\nHost: public\.example\r\n/,
    );
    t.regex(forwarded, /x-keep: keep-me/);
    t.false(forwarded.includes('169.254.169.254'));
    t.false(forwarded.includes('must-not-forward'));
    t.false(forwarded.includes('remove-me'));
    t.regex(forwarded, /7\r\npayload\r\n0\r\n\r\n$/);
    await server.dispose();
    t.true(closed > 0);
  },
);

test.serial(
  'CONNECT carries opaque bytes to port443 and supports prefetched head',
  async t => {
    const opens = [];
    const received = [];
    const arrived = future();
    let sent = false;
    const endpoint = Far('ConnectEndpoint', {
      open(host, port) {
        opens.push({ host, port });
        return Far('ConnectTunnel', {
          write(text) {
            received.push(atob(text));
            arrived.resolve(undefined);
          },
          end() {},
          async read() {
            await arrived.promise;
            if (sent) return null;
            sent = true;
            return btoa('PONG');
          },
          close() {},
        });
      },
    });
    const server = await listener(t, endpoint);
    const response = await exchange(
      t,
      server.url,
      'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\nPING',
    );
    t.regex(response, /^HTTP\/1\.1 200 Connection Established\r\n\r\nPONG$/);
    t.deepEqual(received, ['PING']);
    t.deepEqual(opens, [{ host: 'public.example', port: 443 }]);
  },
);

test.serial(
  'invalid targets, credentials, nonstandard ports and upgrades never acquire authority',
  async t => {
    let opens = 0;
    const endpoint = Far('UnexpectedEndpoint', {
      open() {
        opens += 1;
        throw Error('unexpected acquisition');
      },
    });
    const server = await listener(t, endpoint);
    for (const line of [
      'GET https://public.example/ HTTP/1.1',
      'GET http://public.example:443/ HTTP/1.1',
      'GET http://user:pass@public.example/ HTTP/1.1',
      'GET /relative HTTP/1.1',
      'CONNECT public.example:22 HTTP/1.1',
      'CONNECT public.example:80 HTTP/1.1',
      'CONNECT public.example:443/path HTTP/1.1',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await exchange(
        t,
        server.url,
        `${line}\r\nHost: public.example\r\n\r\n`,
      );
      t.regex(response, /^HTTP\/1\.1 403/);
    }
    const upgrade = await exchange(
      t,
      server.url,
      'GET http://public.example/ HTTP/1.1\r\nHost: public.example\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    t.is(upgrade, '');
    const expect = await exchange(
      t,
      server.url,
      'POST http://public.example/ HTTP/1.1\r\nHost: public.example\r\nContent-Length: 8\r\nExpect: 100-continue\r\n\r\n',
    );
    t.regex(expect, /^HTTP\/1\.1 417/);
    t.is(opens, 0);
  },
);

test.serial(
  'host private-address refusal is generic and is never reflected',
  async t => {
    const endpoint = Far('DeniedEndpoint', {
      open() {
        throw Error('secret-bearing upstream diagnostic');
      },
    });
    const server = await listener(t, endpoint);
    const response = await exchange(
      t,
      server.url,
      'CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n',
    );
    t.regex(response, /^HTTP\/1\.1 403/);
    t.false(response.includes('secret-bearing'));
  },
);

test.serial(
  'late acquisition after client timeout is closed rather than leaked',
  async t => {
    const acquiring = future();
    const closed = future();
    const endpoint = Far('SlowEndpoint', { open: () => acquiring.promise });
    const server = await listener(t, endpoint, { timeoutMs: 20 });
    const response = await exchange(
      t,
      server.url,
      'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example\r\n\r\n',
    );
    t.is(response, '');
    acquiring.resolve(
      Far('LateTunnel', {
        close: () => {
          closed.resolve(undefined);
        },
      }),
    );
    await closed.promise;
    t.pass();
  },
);

test.serial(
  'response quotas close the tunnel before excess bytes escape',
  async t => {
    let closed = 0;
    const endpoint = Far('OversizedEndpoint', {
      open: () =>
        Far('OversizedTunnel', {
          write() {},
          end() {},
          read: () => btoa('oversized-secret-response'),
          close: () => {
            closed += 1;
          },
        }),
    });
    const server = await listener(t, endpoint, { maxDownloadBytes: 4n });
    const response = await exchange(
      t,
      server.url,
      'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example\r\n\r\n',
    );
    t.false(response.includes('oversized-secret-response'));
    await server.dispose();
    t.true(closed > 0);
  },
);

test.serial(
  'explicit listener disposal terminates clients and remote tunnels',
  async t => {
    const opened = future();
    const closed = future();
    const endpoint = Far('LiveEndpoint', {
      open: () =>
        Far('LiveTunnel', {
          write() {},
          end() {},
          read: () => {
            opened.resolve(undefined);
            return new Promise(() => {});
          },
          close: () => {
            closed.resolve(undefined);
          },
        }),
    });
    const server = await listener(t, endpoint);
    const response = exchange(
      t,
      server.url,
      'CONNECT public.example:443 HTTP/1.1\r\nHost: public.example\r\n\r\n',
    );
    await opened.promise;
    await server.dispose();
    await closed.promise;
    await response;
    t.pass();
  },
);

test.serial(
  'real TCP bridge streams HTTP upload and rejects a redirect to private space',
  async t => {
    t.timeout(3000);
    const uploads = [];
    const origin = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString('utf8');
      uploads.push(body);
      response.writeHead(302, {
        location: 'http://169.254.169.254/latest',
        connection: 'close',
      });
      response.end('redirect');
    });
    t.teardown(
      () => new Promise(resolve => origin.close(() => resolve(undefined))),
    );
    await new Promise(resolve =>
      origin.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = origin.address();
    if (!address || typeof address === 'string')
      throw Error('Fixture did not bind');
    let dials = 0;
    const egress = makePublicEgress({
      policy: 'public-internet',
      localAddresses: [],
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
      connect: settings => {
        t.is(settings.host, '93.184.215.14');
        dials += 1;
        // This trusted fixture dialer alone maps the validated literal to a
        // local server. Production uses the default literal-IP net.connect.
        return createConnection({
          ...settings,
          host: '127.0.0.1',
          port: address.port,
        });
      },
    });
    t.teardown(egress.dispose);
    const proxy = await listener(t, egress.endpoint);
    const response = await exchange(
      t,
      proxy.url,
      'POST http://public.example/package HTTP/1.1\r\nHost: public.example\r\nContent-Length: 7\r\n\r\npayload',
    );
    t.regex(response, /^HTTP\/1\.1 302/);
    t.regex(response, /location: http:\/\/169\.254\.169\.254\/latest/);
    t.deepEqual(uploads, ['payload']);
    const redirected = await exchange(
      t,
      proxy.url,
      'GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n',
    );
    t.regex(redirected, /^HTTP\/1\.1 403/);
    t.is(dials, 1, 'redirect never bypasses destination validation');
  },
);

test.serial(
  'early upstream response completes without waiting for unfinished client upload',
  async t => {
    const closed = future();
    let responseSent = false;
    let uploadEnded = false;
    const endpoint = Far('EarlyResponseEndpoint', {
      open: () =>
        Far('EarlyResponseTunnel', {
          write() {},
          end() {
            uploadEnded = true;
          },
          read() {
            if (responseSent) return null;
            responseSent = true;
            return btoa(
              'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            );
          },
          close() {
            closed.resolve(undefined);
          },
        }),
    });
    const proxy = await listener(t, endpoint);
    // The client sends only one of the promised 9999 bytes and never ends its
    // write side. An early origin response must still finish and close both ends.
    const response = await exchange(
      t,
      proxy.url,
      'POST http://public.example/upload HTTP/1.1\r\nHost: public.example\r\nContent-Length: 9999\r\n\r\nx',
    );
    t.regex(response, /^HTTP\/1\.1 413 Payload Too Large/);
    await closed.promise;
    t.false(
      uploadEnded,
      'the proxy did not pretend the incomplete upload finished',
    );
  },
);

test.serial(
  'HTTP origin can finish its response after reading complete framing',
  async t => {
    const origin = createTcpServer(socket => {
      let bytes = '';
      let scheduled = false;
      socket.on('data', chunk => {
        bytes += chunk.toString('utf8');
        if (!scheduled && bytes.endsWith('0\r\n\r\n')) {
          scheduled = true;
          setTimeout(
            () =>
              socket.end(
                'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nOK',
              ),
            20,
          );
        }
      });
    });
    await new Promise(resolve =>
      origin.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    t.teardown(
      () =>
        new Promise((resolve, reject) =>
          origin.close(error => (error ? reject(error) : resolve(undefined))),
        ),
    );
    const address = origin.address();
    if (!address || typeof address === 'string')
      throw Error('Fixture did not bind');
    const egress = makePublicEgress({
      policy: 'public-internet',
      getLocalAddresses: () => [],
      lookup: async () => [{ address: '93.184.215.14', family: 4 }],
      connect: settings =>
        createConnection({
          ...settings,
          host: '127.0.0.1',
          port: address.port,
        }),
    });
    t.teardown(egress.dispose);
    const proxy = await listener(t, egress.endpoint);
    const response = await exchange(
      t,
      proxy.url,
      'GET http://public.example/ HTTP/1.1\r\nHost: public.example\r\n\r\n',
    );
    t.regex(response, /^HTTP\/1\.1 200 OK/);
    t.true(response.endsWith('OK'));
  },
);

test.serial(
  'early HTTP response survives a rejected remaining upload write',
  async t => {
    let writes = 0;
    let reads = 0;
    const endpoint = Far('EarlyRejectedUploadEndpoint', {
      open: () =>
        Far('EarlyRejectedUploadTunnel', {
          write() {
            writes += 1;
            if (writes > 1) throw Error('origin stopped reading upload');
          },
          end() {},
          async read() {
            reads += 1;
            if (reads > 1) return null;
            await new Promise(resolve => setTimeout(resolve, 20));
            return btoa(
              'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            );
          },
          close() {},
        }),
    });
    const proxy = await listener(t, endpoint);
    const response = await exchange(
      t,
      proxy.url,
      'POST http://public.example/upload HTTP/1.1\r\nHost: public.example\r\nContent-Length: 9999\r\n\r\nx',
    );
    t.regex(response, /^HTTP\/1\.1 413 Payload Too Large/);
  },
);

test.serial(
  'rejected HTTP upload cannot retain a silent response indefinitely',
  async t => {
    let writes = 0;
    const closed = future();
    const endpoint = Far('SilentRejectedUploadEndpoint', {
      open: () =>
        Far('SilentRejectedUploadTunnel', {
          write() {
            writes += 1;
            if (writes > 1) throw Error('origin stopped reading upload');
          },
          end() {},
          read: () => new Promise(() => {}),
          close: () => closed.resolve(undefined),
        }),
    });
    const proxy = await listener(t, endpoint);
    const response = await exchange(
      t,
      proxy.url,
      'POST http://public.example/upload HTTP/1.1\r\nHost: public.example\r\nContent-Length: 9999\r\n\r\nx',
    );
    t.is(response, '');
    await closed.promise;
  },
);
