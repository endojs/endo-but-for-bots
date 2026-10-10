// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { spawn } from 'node:child_process';

import { makeProviderPipe } from '../src/provider-pipe.js';
import { readHttpText, requestHttp } from './http-client.js';

test.serial(
  'separate credential-free worker forwards HTTP over private capability pipes',
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
    await E(control).stop();
    pipe.close();
    t.is(await finished, 0, diagnostics);
  },
);
