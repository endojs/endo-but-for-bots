// @ts-check
import '@endo/init';
import test from 'ava';
import { execFileSync } from 'node:child_process';

import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { Far } from '@endo/far';

import {
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
} from '../src/broker-launch.js';
import { makeCodexRuntimeVerifier } from '../src/runtime-verifier.js';

// Controlled process doubles test admission and cleanup, not Linux enforcement.
const launchEnvironment = harden({
  CODEX_HOME: '/codex-home',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TEMP: '/tmp',
  TMP: '/tmp',
  TMPDIR: '/tmp',
  TZ: 'UTC',
});

/** @param {any} [options] */
const fixture = ({
  stdout = 'CODEX_RUNTIME_PROBE_V1_OK\n',
  stderr = '',
  code = 0,
  stall = false,
  late = false,
  timeoutMs = 1000,
} = {}) => {
  let kills = 0;
  let waits = 0;
  let spawnCall;
  /** @type {(value?: any) => void} */
  let finish = () => {};
  const completion = new Promise(resolve => {
    finish = resolve;
  });
  const proc = Far('controlled probe', {
    async stdout() {
      return bytesReaderFromIterator([new TextEncoder().encode(stdout)]);
    },
    async stderr() {
      return bytesReaderFromIterator([new TextEncoder().encode(stderr)]);
    },
    async wait() {
      waits += 1;
      if (stall) await completion;
      return harden({ code, signal: null });
    },
    async kill() {
      kills += 1;
      finish();
    },
  });
  const slice = Far('controlled slice', {
    async spawn(argv, options) {
      spawnCall = { argv, options };
      if (late) await completion;
      return proc;
    },
  });
  const context = harden({
    slice,
    launchEnvironment,
    brokerEndpoint: 'http://127.0.0.1:1234',
    launchArgv: makeBrokerAppServerArgv('http://127.0.0.1:1234'),
    sessionId: 'session',
    leaseId: 'lease',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    networkNamespaceId: 'namespace',
  });
  return {
    verifier: makeCodexRuntimeVerifier({ timeoutMs }),
    context,
    call: () => spawnCall,
    kills: () => kills,
    waits: () => waits,
    finish,
    proc,
  };
};

test('public preflight binds exact proxy evidence and retains native broker denial probes', async t => {
  const f = fixture();
  const network = harden({
    policy: 'public-internet',
    proxyUrl: 'http://207.148.100.198:23457',
    dnsHost: '127.0.0.53',
    resolverConfigPath: '/private/provider/public-resolv.conf',
  });
  const context = harden({
    ...f.context,
    network,
    launchEnvironment: makeBrokerEnvironment(network),
    launchArgv: makeBrokerAppServerArgv(
      f.context.brokerEndpoint,
      'codex',
      network,
    ),
  });
  const result = await E(f.verifier).attest(context);
  t.is(result.toolBrokerAccess, 'denied');
  t.is(result.environment, 'credential-free-managed-proxy');
  t.deepEqual(result.network, network);
  const payload = JSON.parse(f.call().argv[4]);
  t.deepEqual(payload.network, network);
  t.regex(payload.inner, /managed proxy admitted broker/);
  // Compiling both Python programs catches escaping bugs without executing any
  // host operation or pretending this is a kernel-isolation test.
  const encoded = JSON.stringify([f.call().argv[3], payload.inner]);
  execFileSync('python3', [
    '-I',
    '-c',
    'import json,sys; [compile(source,"probe","exec") for source in json.loads(sys.argv[1])]',
    encoded,
  ]);
  t.false(payload.inner.includes('\\\\r\\\\n'));
});

test('controlled probe success binds evidence and launches exact bounded preflight', async t => {
  const f = fixture();
  const result = await E(f.verifier).attest(f.context);
  t.like(result, {
    version: 'CodexRuntimeEvidenceV1',
    sessionId: 'session',
    leaseId: 'lease',
    networkNamespaceId: 'namespace',
    environment: 'credential-and-proxy-free',
    codexHomeAuthFile: 'absent',
  });
  const { argv, options } = f.call();
  t.deepEqual(argv.slice(0, 3), ['python3', '-I', '-c']);
  t.like(options, {
    env: launchEnvironment,
    cwd: '/workspace',
    timeoutMs: 1000,
    stdoutByteLimit: 4096n,
    stderrByteLimit: 4096n,
  });
  const payload = JSON.parse(argv[4]);
  t.deepEqual(payload.sandboxArgv, [
    ...f.context.launchArgv.slice(0, -3),
    'sandbox',
  ]);
  t.is(payload.port, 1234);
  t.is(f.kills(), 0);
  t.is(f.waits(), 1);
});

for (const [label, options] of [
  ['exit failure', { code: 1 }],
  ['wrong marker', { stdout: 'canary-secret' }],
  ['stdout overflow', { stdout: 'x'.repeat(4097) }],
  ['stderr overflow', { stderr: 'x'.repeat(4097) }],
]) {
  test(`controlled ${label} fails closed and reaps without leaking output`, async t => {
    const f = fixture(options);
    await t.throwsAsync(() => E(f.verifier).attest(f.context), {
      message: 'Codex runtime verification failed',
    });
    t.is(f.kills(), 1);
    t.true(f.waits() >= 1);
  });
}

test('controlled hanging probe is killed and reaped after deadline', async t => {
  t.timeout(2000);
  const f = fixture({ stall: true, timeoutMs: 10 });
  await t.throwsAsync(() => E(f.verifier).attest(f.context), {
    message: 'Codex runtime verification failed',
  });
  t.is(f.kills(), 1);
  t.is(f.waits(), 2);
});

test('controlled late process acquisition is cancelled after rejected admission', async t => {
  t.timeout(2000);
  const f = fixture({ late: true, timeoutMs: 10 });
  await t.throwsAsync(() => E(f.verifier).attest(f.context), {
    message: 'Codex runtime verification failed',
  });
  f.finish();
  // Barrier on the returned process after the late spawn continuation.
  await Promise.resolve();
  await E(f.proc).wait();
  t.is(f.kills(), 1);
});

test('environment and launch widening fail before spawning', async t => {
  const f = fixture();
  await t.throwsAsync(
    () =>
      E(f.verifier).attest(
        harden({
          ...f.context,
          launchEnvironment: {
            ...launchEnvironment,
            HTTPS_PROXY: 'canary-secret',
          },
        }),
      ),
    { message: /environment mismatch/ },
  );
  await t.throwsAsync(
    () =>
      E(f.verifier).attest(
        harden({
          ...f.context,
          launchArgv: ['codex', '--yolo'],
        }),
      ),
    { message: /launch mismatch/ },
  );
  t.is(f.call(), undefined);
  t.throws(
    () =>
      makeCodexRuntimeVerifier({
        imageEnvironment: { OPENAI_API_KEY: 'canary-secret' },
      }),
    { message: /Unapproved image environment/ },
  );
  t.throws(
    () =>
      makeCodexRuntimeVerifier({
        imageEnvironment: { PATH: '/workspace' },
      }),
    { message: /Unapproved image environment/ },
  );
  t.throws(
    () =>
      makeCodexRuntimeVerifier({
        imageEnvironment: { HOSTNAME: 'unbound-container' },
      }),
    { message: /Unapproved image environment/ },
  );
});

test('actual Python parent executes with controlled platform and fake Codex children', async t => {
  t.timeout(5000);
  const f = fixture();
  await E(f.verifier).attest(f.context);
  const { argv } = f.call();
  // Execute the real parent script. Only OS identity, broker connection and
  // Codex children are doubled. This catches Python orchestration errors but
  // deliberately makes no claim about Linux sandbox enforcement.
  const harness = String.raw`
import contextlib,json,os,socket,subprocess,sys,tempfile
source,payload=json.load(sys.stdin)
sys.platform="linux"
os.environ=dict(payload["environment"])
socket.create_connection=lambda *args,**kwargs: contextlib.nullcontext()
popen=subprocess.Popen
mkdtemp=tempfile.mkdtemp
children=[]
def fake_codex(argv,**kwargs):
    children.append(argv)
    if argv==["codex","--version"]:
        code="print('codex-cli 0.152.0')"
    else:
        assert argv[:len(payload["sandboxArgv"])]==payload["sandboxArgv"]
        inner=json.loads(argv[-1])
        assert all(os.path.isdir(inner[k]) for k in ("workspace","home","tmp","run","scratch"))
        assert open(inner["home"]+"/sentinel").read()=="sentinel"
        assert os.path.samefile(inner["home"]+"/sentinel",inner["home"]+"/hardlink")
        assert os.path.islink(inner["workspace"]+"/alias")
        code="print('INNER_OK')"
    return popen([sys.executable,"-I","-c",code],**kwargs)
subprocess.Popen=fake_codex
with tempfile.TemporaryDirectory(prefix="endo-probe-control-") as root:
    tempfile.mkdtemp=lambda **kwargs: mkdtemp(prefix=kwargs["prefix"],dir=root)
    sys.argv=["probe",json.dumps(payload)]
    exec(compile(source,"runtime-probe","exec"),{})
    assert len(children)==2
    assert os.listdir(root)==[], "probe did not clean up"
`;
  const output = execFileSync('python3', ['-I', '-c', harness], {
    input: JSON.stringify([argv[3], JSON.parse(argv[4])]),
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 16 * 1024,
  });
  t.is(output, 'CODEX_RUNTIME_PROBE_V1_OK\n');
});
