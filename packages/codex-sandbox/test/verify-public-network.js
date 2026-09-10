// @ts-check
import '@endo/init';

import { E, Far } from '@endo/far';
import { makePodmanProviderListenerRuntime } from '@endo/hosted-agent/provider-listener-runtime.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
} from '../src/broker-launch.js';
import { makePublicEgress } from '../src/public-egress.js';

// Explicit operator acceptance command. Uses no credentials or real provider
// account; public HTTP(S) requests carry only a synthetic read-only test.
const [imageRef, bootstrapImageRef, address] = process.argv.slice(2);
if (!imageRef || !bootstrapImageRef || !address)
  throw Error('listener image, Codex image, and operator IPv4 required');
const directory = await mkdtemp(join(tmpdir(), 'endo-public-runtime-'));
const name = `endo-public-probe-${randomUUID()}`;
const execute = promisify(execFile);
const egress = makePublicEgress({
  policy: 'public-internet',
  async lookup(hostname, options) {
    const answers = await lookup(hostname, options);
    process.stderr.write(
      `${JSON.stringify({ stage: 'public-test-dns', hostname, answers })}\n`,
    );
    return answers;
  },
  connect(options) {
    const socket = createConnection(options);
    socket.on('error', error =>
      process.stderr.write(
        `${JSON.stringify({ stage: 'public-test-connect-error', address: options.host, family: options.family, code: /** @type {NodeJS.ErrnoException} */ (error).code })}\n`,
      ),
    );
    return socket;
  },
});
const diagnosticEndpoint = Far('Synthetic public network diagnostics', {
  resolvePublic: hostname => E(egress.endpoint).resolvePublic(hostname),
  async open(hostname, port) {
    const tunnel = await E(egress.endpoint).open(hostname, port);
    process.stderr.write(`PUBLIC_OPEN ${hostname}:${port}\n`);
    let first = true;
    return Far('Synthetic public tunnel diagnostics', {
      async read() {
        const chunk = await E(tunnel).read();
        if (chunk === null) process.stderr.write(`PUBLIC_EOF ${port}\n`);
        if (first && port === 80 && chunk !== null) {
          process.stderr.write(
            `PUBLIC_HTTP_STATUS ${atob(chunk).split('\r\n')[0]}\n`,
          );
          first = false;
        }
        return chunk;
      },
      async write(chunk) {
        try {
          return await E(tunnel).write(chunk);
        } catch (error) {
          process.stderr.write(`PUBLIC_WRITE_FAILED ${port}\n`);
          throw error;
        }
      },
      end: () => {
        process.stderr.write(`PUBLIC_END ${port}\n`);
        return E(tunnel).end();
      },
      close: () => E(tunnel).close(),
    });
  },
});
let runtime;
let clean = false;
let brokerRequests = 0;
const failures = [];
try {
  runtime = await makePodmanProviderListenerRuntime({
    imageRef,
    ownerId: `public-test-${randomUUID()}`,
    stateDirectory: directory,
    publicInternet: { address, bootstrapImageRef },
  });
  const listener = await runtime.start({
    endpoint: Far('No provider credentials', {
      requestStream() {
        brokerRequests += 1;
        let sent = false;
        return harden({
          status: 200,
          contentType: 'application/json',
          reader: Far('Synthetic inference reader', {
            next: () => {
              if (sent) return harden({ done: true });
              sent = true;
              return harden({ done: false, value: '{"synthetic":true}' });
            },
            return: () => harden({ done: true }),
          }),
        });
      },
    }),
    limits: {
      maxConnections: 4,
      maxRequestBytes: 1024n,
      maxResponseBytes: 1024n,
      timeoutMs: 5000,
    },
    network: { address, endpoint: diagnosticEndpoint },
  });
  const evidence = await listener.observe();
  const env = makeBrokerEnvironment(evidence.network);
  const broker = new URL(evidence.endpoint);
  await execute(
    'podman',
    [
      'exec',
      '--user',
      '1000:1000',
      evidence.containerName,
      'node',
      '-e',
      `fetch(${JSON.stringify(`${evidence.endpoint}/v1/responses`)},{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"controlled"}'}).then(async response=>{if(response.status!==200||(await response.text())!=='{"synthetic":true}')process.exit(1)}).catch(()=>process.exit(1))`,
    ],
    { timeout: 10_000, maxBuffer: 4096 },
  );
  if (brokerRequests !== 1)
    throw Error('Synthetic inference path did not work');
  const inner = String.raw`
import errno,json,os,socket,sys,urllib.request
from urllib.parse import urlparse
p=json.loads(os.environ['PROBE'])
status=dict(line.split(':',1) for line in open('/proc/self/status') if ':' in line)
assert all(int(status[k].strip(),16)==0 for k in ('CapEff','CapPrm','CapBnd'))
for host,port in [(p['brokerHost'],p['brokerPort']),(p['proxyHost'],p['proxyPort'])]:
    try: socket.create_connection((host,port),timeout=2)
    except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM,errno.ECONNREFUSED,errno.ENETUNREACH)
    else: raise AssertionError('native direct transport admitted')
proxy=urlparse(os.environ['HTTP_PROXY'])
for host in ('127.0.0.1','127.1','2130706433','0x7f000001','[::ffff:127.0.0.1]','[::1]'):
    for method in ('POST','CONNECT'):
        with socket.create_connection((proxy.hostname,proxy.port),timeout=3) as connection:
            target='http://'+host+':'+str(p['brokerPort'])+'/v1/responses' if method=='POST' else host+':'+str(p['brokerPort'])
            body='{"model":"controlled"}' if method=='POST' else ''
            connection.sendall((method+' '+target+' HTTP/1.1\r\nHost: '+host+':'+str(p['brokerPort'])+'\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body))+'\r\nConnection: close\r\n\r\n'+body).encode())
            status=connection.recv(1024).split(b'\r\n')[0]
            # The pinned proxy rejects some noncanonical authorities as malformed
            # before policy evaluation. Neither response is an inference response;
            # the valid canonical request above proves the broker path independently.
            denied=status.startswith(b'HTTP/1.1 403') or (host!='127.0.0.1' and status.startswith(b'HTTP/1.1 400'))
            assert denied, 'unexpected broker alias result '+method+' '+host+' '+repr(status)
for scheme in ('http','https'):
    print('PUBLIC_REQUEST_START '+scheme,file=sys.stderr,flush=True)
    with urllib.request.urlopen(scheme+'://example.com/',timeout=12) as response:
        assert response.status==200
        assert b'Example Domain' in response.read(32768)
    print('PUBLIC_REQUEST_OK '+scheme,file=sys.stderr,flush=True)
print('PUBLIC_HTTP_HTTPS_AND_BROKER_DENIAL_OK')
`;
  const proxy = new URL(evidence.network.proxyUrl);
  const argv = makeBrokerAppServerArgv(
    evidence.endpoint,
    'codex',
    evidence.network,
  );
  const args = [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--network',
    `container:${evidence.containerName}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=1000:1000',
    '--memory=512m',
    '--memory-swap=512m',
    '--pids-limit=128',
    '--cpus=1',
    '--mount',
    `type=bind,source=${evidence.network.resolverConfigPath},destination=/etc/resolv.conf,ro,nosuid,nodev,bind-propagation=rprivate`,
    ...['/workspace', '/codex-home', '/tmp', '/run', '/scratch'].flatMap(
      path => ['--tmpfs', `${path}:rw,size=32m,mode=1777,nosuid,nodev`],
    ),
    ...Object.entries(env).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]),
    '--env',
    `PROBE=${JSON.stringify({ brokerHost: broker.hostname, brokerPort: Number(broker.port), proxyHost: proxy.hostname, proxyPort: Number(proxy.port) })}`,
    '--workdir=/workspace',
    '--entrypoint=codex',
    bootstrapImageRef,
    ...argv.slice(1, -3),
    'sandbox',
    '--',
    'python3',
    '-I',
    '-c',
    inner,
  ];
  const result = await execute('podman', args, {
    timeout: 45_000,
    maxBuffer: 65_536,
  });
  if (result.stdout.trim() !== 'PUBLIC_HTTP_HTTPS_AND_BROKER_DENIAL_OK')
    throw Error('Unexpected acceptance output');
  if (brokerRequests !== 1)
    throw Error('Tool request reached inference broker');
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  await listener.stop();
  clean = true;
} catch (error) {
  failures.push(error);
} finally {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => egress.dispose()),
    execute('podman', ['rm', '-f', '--ignore', '--time', '1', name], {
      timeout: 10_000,
      maxBuffer: 4096,
    }),
    Promise.resolve().then(() => runtime?.dispose()),
  ]);
  const cleanupFailures = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  failures.push(...cleanupFailures);
  if (cleanupFailures.length) {
    process.stderr.write(
      `Public network cleanup incomplete; retain ${directory} for retry\n`,
    );
  } else {
    await rm(directory, { recursive: true, force: true }).catch(error =>
      failures.push(error),
    );
  }
}
if (failures.length)
  throw new AggregateError(failures, 'Public network verification failed');
if (!clean) throw Error('Public network verification incomplete');
