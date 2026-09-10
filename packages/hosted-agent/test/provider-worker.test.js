// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { Far } from '@endo/far';
import { spawn } from 'node:child_process';

import { makeProviderPipe } from '../src/provider-pipe.js';
import { readHttpText, requestHttp } from './http-client.js';

for (const diagnosticsEnabled of [false, true]) {
  test.serial(
    `separate credential-free worker forwards HTTP over private capability pipes (diagnostics=${diagnosticsEnabled})`,
    async t => {
      t.timeout(5000);
      const worker = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { startProviderListenerWorker } from ${JSON.stringify(new URL('../src/provider-worker.js', import.meta.url).href)}; await startProviderListenerWorker({input:process.stdin,output:process.stdout});`,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            NODE_VERSION: '22.19.0',
            YARN_VERSION: '1.22.22',
            HOME: '/home/node',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
          },
        },
      );
      let diagnostics = '';
      worker.stderr.on('data', chunk => {
        diagnostics += chunk;
      });
      const finished = new Promise(resolve => worker.once('close', resolve));
      t.teardown(async () => {
        worker.kill();
        await finished;
        if (diagnostics) t.log(diagnostics);
      });
      let calls = 0;
      const endpoint = Far('host-only inference', {
        requestStream(request) {
          calls += 1;
          t.is(request.path, '/v1/responses');
          if (calls === 2) throw Fail`Inference quota exhausted`;
          let done = false;
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: Far('host-only reader', {
              async next() {
                if (done) return harden({ done: true, value: '' });
                done = true;
                return harden({ done: false, value: 'data: hello\n\n' });
              },
              return() {},
            }),
          });
        },
      });
      const pipe = makeProviderPipe({
        input: worker.stdout,
        output: worker.stdin,
        bootstrap: harden({
          endpoint,
          limits: {
            diagnostics: diagnosticsEnabled,
            maxConnections: 2,
            maxRequestBytes: 1024n,
            maxResponseBytes: 1024n,
            timeoutMs: 1000,
          },
        }),
      });
      t.teardown(pipe.close);
      const control = await pipe.getBootstrap();
      const ready = await E(control).ready();
      const response = await requestHttp(`${ready.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"allowed"}',
      });
      t.is(await readHttpText(response), 'data: hello\n\n');
      t.is(calls, 1);
      const rejected = await requestHttp(`${ready.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"allowed"}',
      });
      t.is(rejected.statusCode, 502);
      t.is(await readHttpText(rejected), 'Inference request failed');
      const subsequent = await requestHttp(`${ready.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model":"allowed"}',
      });
      t.is(subsequent.statusCode, 200);
      t.is(await readHttpText(subsequent), 'data: hello\n\n');
      t.is(calls, 3);
      for (let index = 0; index < 5; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        const denied = await requestHttp(`${ready.endpoint}/v1/responses`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'canary-header-secret',
          },
          body: 'canary-body-secret',
        });
        t.is(denied.statusCode, 502);
        // eslint-disable-next-line no-await-in-loop
        await readHttpText(denied);
      }
      await E(control).stop();
      pipe.close();
      t.is(await finished, 0, diagnostics);
      const lines = diagnostics
        .split('\n')
        .filter(line => line.startsWith('Provider HTTP diagnostic: '));
      t.is(lines.length, diagnosticsEnabled ? 4 : 0);
      t.true(lines.join('\n').length < 4096);
      t.false(lines.join('\n').includes('canary'));
      if (diagnosticsEnabled) {
        t.deepEqual(
          JSON.parse(lines[0].slice('Provider HTTP diagnostic: '.length)),
          { stage: 'endpoint' },
        );
        t.like(
          JSON.parse(lines[1].slice('Provider HTTP diagnostic: '.length)),
          {
            stage: 'headers',
            checks: { authorization: false },
          },
        );
      }
    },
  );
}

test.serial(
  'network listeners start only after trusted activation and are disposed with the worker',
  async t => {
    t.timeout(5000);
    const worker = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { startProviderListenerWorker } from ${JSON.stringify(new URL('../src/provider-worker.js', import.meta.url).href)};
    import { E } from '@endo/eventual-send';
    await startProviderListenerWorker({input:process.stdin,output:process.stdout,
      async makeNetworkListeners({endpoint}) {
        await E(endpoint).activated();
        return harden({evidence:{policy:'test-only'},dispose:()=>E(endpoint).disposed()});
      }});
  `,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          NODE_VERSION: '22.19.0',
          YARN_VERSION: '1.22.22',
          HOME: '/home/node',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      },
    );
    const finished = new Promise(resolve => worker.once('close', resolve));
    t.teardown(async () => {
      worker.kill();
      await finished;
    });
    let activations = 0;
    let disposals = 0;
    const pipe = makeProviderPipe({
      input: worker.stdout,
      output: worker.stdin,
      bootstrap: harden({
        endpoint: Far('unused inference', {
          requestStream() {
            throw Error('unused');
          },
        }),
        limits: {
          maxConnections: 2,
          maxRequestBytes: 1024n,
          maxResponseBytes: 1024n,
          timeoutMs: 1000,
        },
        network: {
          endpoint: Far('test network lifecycle', {
            activated() {
              activations += 1;
            },
            disposed() {
              disposals += 1;
            },
          }),
        },
      }),
    });
    t.teardown(pipe.close);
    const control = await pipe.getBootstrap();
    await E(control).ready();
    t.is(activations, 0);
    t.deepEqual(
      await Promise.all([
        E(control).activateNetwork(),
        E(control).activateNetwork(),
      ]),
      [{ policy: 'test-only' }, { policy: 'test-only' }],
    );
    t.is(activations, 1);
    await E(control).stop();
    t.is(disposals, 1);
    await t.throwsAsync(E(control).activateNetwork(), {
      message: /network unavailable|Provider pipe closed/,
    });
    pipe.close();
    t.is(await finished, 0);
  },
);
