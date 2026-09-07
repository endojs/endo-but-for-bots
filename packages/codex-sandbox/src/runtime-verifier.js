// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { M } from '@endo/patterns';

import {
  assertBrokerEndpoint,
  makeBrokerAppServerArgv,
} from './broker-launch.js';

const INNER = String.raw`
import errno,json,os,socket,subprocess,sys
p=json.loads(sys.argv[1])
def denied(action):
    try:
        action()
    except OSError as e:
        assert e.errno in (errno.EPERM,errno.EACCES,errno.EROFS), "wrong denial"
    else:
        raise AssertionError("operation allowed")
status=dict(line.split(":",1) for line in open("/proc/self/status") if ":" in line)
assert status["NoNewPrivs"].strip()=="1"
assert status["Seccomp"].strip()=="2"
with open(p["workspace"]+"/allowed","w") as f: f.write("ok")
with open(p["tmp"]+"/allowed","w") as f: f.write("ok")
with open(p["run"]+"/allowed","w") as f: f.write("ok")
with open(p["scratch"]+"/allowed","w") as f: f.write("ok")
denied(lambda: open(p["home"]+"/sentinel","w"))
denied(lambda: open(p["workspace"]+"/alias","w"))
denied(lambda: os.rename(p["home"]+"/rename-source",p["home"]+"/sentinel"))
denied(lambda: open(p["home"]+"/hardlink","w"))
denied(lambda: os.link(p["home"]+"/sentinel",p["home"]+"/linked"))
denied(lambda: socket.create_connection((p["host"],p["port"]),timeout=2))
child=subprocess.run([sys.executable,"-I","-c",
    "import os; open("+repr(p["home"]+"/sentinel")+",'w').write('bad')"],
    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
assert child.returncode != 0
assert open(p["home"]+"/sentinel").read()=="sentinel"
print("INNER_OK")
`;

const PROBE = String.raw`
import json,os,re,select,shutil,socket,subprocess,sys,tempfile,time
def run(argv,timeout):
    child=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    output={child.stdout:bytearray(),child.stderr:bytearray()}
    opened=list(output)
    until=time.monotonic()+timeout
    try:
        while opened:
            remaining=until-time.monotonic()
            assert remaining>0, "child deadline"
            readable,_,_=select.select(opened,[],[],remaining)
            assert readable, "child deadline"
            for stream in readable:
                chunk=os.read(stream.fileno(),4096)
                if not chunk:
                    opened.remove(stream)
                else:
                    assert len(output[stream])+len(chunk)<=4096, "child output limit"
                    output[stream].extend(chunk)
        assert child.wait(timeout=max(0.01,until-time.monotonic()))==0
        return bytes(output[child.stdout]).decode("utf-8")
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()
p=json.loads(sys.argv[1])
assert sys.platform=="linux"
observed=dict(os.environ)
if "PWD" in observed:
    assert observed.pop("PWD")==os.getcwd()=="/workspace", "cwd metadata mismatch"
if "container" in observed:
    assert observed.pop("container")=="podman", "container metadata mismatch"
if "HOSTNAME" in observed:
    hostname=observed.pop("HOSTNAME")
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,63}",hostname)
    assert hostname==socket.gethostname(), "hostname metadata mismatch"
assert observed==p["environment"], "environment mismatch: known="+",".join(k for k,v in p["environment"].items() if observed.get(k)!=v)+" unexpected-count="+str(len(set(observed)-set(p["environment"]))) 
assert run(["codex","--version"],5).strip()=="codex-cli 0.152.0"
with socket.create_connection((p["host"],p["port"]),timeout=2): pass
created=[]
try:
    for root in ("/workspace","/codex-home","/tmp","/run","/scratch"):
        created.append(tempfile.mkdtemp(prefix=".endo-runtime-probe-",dir=root))
    workspace,home,tmp,run_dir,scratch=created
    with open(home+"/sentinel","w") as f: f.write("sentinel")
    with open(home+"/rename-source","w") as f: f.write("replacement")
    os.symlink(home+"/sentinel",workspace+"/alias")
    os.link(home+"/sentinel",home+"/hardlink")
    inner=dict(workspace=workspace,home=home,tmp=tmp,run=run_dir,scratch=scratch,host=p["host"],port=p["port"])
    result=run(p["sandboxArgv"]+["--",sys.executable,"-I","-c",p["inner"],json.dumps(inner)],15)
    assert result.strip()=="INNER_OK"
    assert open(home+"/sentinel").read()=="sentinel"
finally:
    for directory in reversed(created): shutil.rmtree(directory)
print("CODEX_RUNTIME_PROBE_V1_OK")
`;

/**
 * Probe the exact slice before admitting its pinned runtime. This is a live
 * preflight of the trusted image's sandbox implementation, not continuous
 * observation of the later app-server. The caller must bind that process to the
 * same launch argv/environment and validate its merged configuration.
 * Known image metadata is exact; Podman container metadata is fixed, and
 * HOSTNAME must match the running kernel hostname.
 * Controlled tests exercise admission mechanics, never claim kernel evidence.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.imageEnvironment] Exact trusted image
 * metadata in addition to launchEnvironment; unknown effective names fail.
 * @param {number} [options.timeoutMs]
 */
export const makeCodexRuntimeVerifier = ({
  imageEnvironment = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    SOURCE_DATE_EPOCH: '1757376000',
    NODE_VERSION: '22.19.0',
    YARN_VERSION: '1.22.22',
  },
  timeoutMs = 30_000,
} = {}) => {
  (Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 0x7fff_ffff) ||
    Fail`Invalid runtime probe deadline`;
  const imageEnv = harden({ ...imageEnvironment });
  const knownImageEnv = harden({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    SOURCE_DATE_EPOCH: '1757376000',
    NODE_VERSION: '22.19.0',
    YARN_VERSION: '1.22.22',
  });
  for (const [key, value] of Object.entries(imageEnv)) {
    (Object.hasOwn(knownImageEnv, key) && knownImageEnv[key] === value) ||
      Fail`Unapproved image environment`;
  }
  const approvedEnvironment = harden({
    CODEX_HOME: '/codex-home',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TEMP: '/tmp',
    TMP: '/tmp',
    TMPDIR: '/tmp',
    TZ: 'UTC',
  });
  return makeExo(
    'CodexRuntimeVerifier',
    M.interface('CodexRuntimeVerifier', {
      attest: M.call(M.record()).returns(M.promise()),
    }),
    {
      /** @param {any} context */
      async attest(context) {
        (Object.keys(context.launchEnvironment).length ===
          Object.keys(approvedEnvironment).length &&
          Object.entries(approvedEnvironment).every(
            ([key, value]) => context.launchEnvironment[key] === value,
          )) ||
          Fail`Runtime environment mismatch`;
        const endpoint = new URL(assertBrokerEndpoint(context.brokerEndpoint));
        const expectedArgv = makeBrokerAppServerArgv(endpoint.origin);
        (Array.isArray(context.launchArgv) &&
          JSON.stringify(context.launchArgv) ===
            JSON.stringify(expectedArgv)) ||
          Fail`Runtime launch mismatch`;
        const payload = harden({
          environment: { ...imageEnv, ...context.launchEnvironment },
          host: endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname,
          port: Number(endpoint.port || 80),
          sandboxArgv: [...expectedArgv.slice(0, -3), 'sandbox'],
          inner: INNER,
        });
        /** @type {any} */
        let proc;
        let expired = false;
        /** @type {ReturnType<typeof globalThis.setTimeout> | undefined} */
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = globalThis.setTimeout(() => {
            expired = true;
            reject(makeError(X`Runtime probe timed out`));
          }, timeoutMs);
        });
        const spawning = E(context.slice)
          .spawn(
            harden(['python3', '-I', '-c', PROBE, JSON.stringify(payload)]),
            harden({
              env: context.launchEnvironment,
              cwd: '/workspace',
              timeoutMs,
              captureStdout: true,
              captureStderr: true,
              stdoutByteLimit: 4096n,
              stderrByteLimit: 4096n,
            }),
          )
          .then(async handle => {
            if (expired) {
              await E(handle).kill();
              await E(handle)
                .wait()
                .catch(() => {});
              throw makeError(X`Late runtime probe`);
            }
            return handle;
          });
        /** @param {any} reader */
        const collect = async reader => {
          let count = 0n;
          const parts = [];
          const decoder = new TextDecoder('utf-8', { fatal: true });
          for await (const bytes of iterateBytesReader(reader, { buffer: 0 })) {
            count += BigInt(bytes.byteLength);
            count <= 4096n || Fail`Runtime probe output exceeded`;
            parts.push(decoder.decode(bytes, { stream: true }));
          }
          parts.push(decoder.decode());
          return parts.join('');
        };
        try {
          proc = await Promise.race([spawning, deadline]);
          const [stdout, , result] = await Promise.race([
            Promise.all([
              E(proc).stdout().then(collect),
              E(proc).stderr().then(collect),
              E(proc).wait(),
            ]),
            deadline,
          ]);
          (result.code === 0 &&
            result.signal === null &&
            stdout === 'CODEX_RUNTIME_PROBE_V1_OK\n') ||
            Fail`Runtime probe failed`;
          return harden({
            version: 'CodexRuntimeEvidenceV1',
            sessionId: context.sessionId,
            imageDigest: context.imageDigest,
            leaseId: context.leaseId,
            networkNamespaceId: context.networkNamespaceId,
            toolSandbox: 'codex-workspace-write',
            toolCodexHomeAccess: 'read-only',
            toolBrokerAccess: 'denied',
            environment: 'credential-and-proxy-free',
          });
        } catch (_error) {
          if (proc) {
            // Slice admission failure also disposes the entire slice. A kill
            // failure cannot be turned into successful runtime evidence.
            let cleanupTimer;
            try {
              await Promise.race([
                E(proc)
                  .kill()
                  .then(() => E(proc).wait())
                  .catch(() => {}),
                new Promise(resolve => {
                  cleanupTimer = globalThis.setTimeout(resolve, 1000);
                }),
              ]);
            } finally {
              globalThis.clearTimeout(cleanupTimer);
            }
          }
          return Fail`Codex runtime verification failed`;
        } finally {
          globalThis.clearTimeout(timer);
        }
      },
    },
  );
};
harden(makeCodexRuntimeVerifier);
