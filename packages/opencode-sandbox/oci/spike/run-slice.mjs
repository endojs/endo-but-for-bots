// Tokyo-slice spike harness for @endo/opencode-sandbox.
//
// Run as the Endo daemon user through the endo CLI:
//
//   sudo -u endo env SPIKE_IMAGE=localhost/opencode-sandbox:<commit> \
//     SPIKE_MODE=normal /bin/sh oci/spike/run.sh
//   sudo -u endo env SPIKE_IMAGE=... SPIKE_MODE=compact /bin/sh oci/spike/run.sh
//
// The OpenRouter key is read from the Endo secrets manager and handed to
// podman by environment inheritance: it is not printed or placed in argv, but
// podman does persist it in the container record, so a crashed run must be
// reaped (the harness removes the named container on any spawn failure).
// SPIKE_CHECK=1 stops after proving the secret is readable.
//
// - normal: one turn, asserts streaming `part_delta` events reach stdout.
// - compact: forces a tiny context limit so auto-compaction triggers, then
//   asserts the summary and synthetic continuation do not leak into stdout.
//   The turn can run until the timeout, which is expected: the `run` surface
//   has no interrupt and the caller must enforce a budget.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE = process.env.ENDO_RELEASE || '/var/lib/endo/current';
const MODEL = process.env.SPIKE_MODEL || 'openrouter/deepseek/deepseek-v4.1-flash';
const IMAGE = process.env.SPIKE_IMAGE;
const WORKDIR = process.env.SPIKE_WORKDIR || '/var/lib/endo/opencode-spike/work';
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS || 240000);

export const main = async host => {
  if (!IMAGE) throw Error('SPIKE_IMAGE is required, e.g. localhost/opencode-sandbox:<commit>');
  if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) throw Error('invalid SPIKE_TIMEOUT_MS');

  const { E } = await import(
    pathToFileURL(`${RELEASE}/packages/eventual-send/src/no-shim.js`).href
  );

  const blob = await E(host).lookup(['secrets', 'openrouter-auth']);
  const base64 = await E(blob).readBase64();
  const token = Buffer.from(base64, 'base64').toString('utf8');
  if (!token || token.length < 10) throw Error('OpenRouter secret came back empty');

  if (process.env.SPIKE_CHECK === '1') {
    console.log(JSON.stringify({ secretBytes: token.length, image: IMAGE }));
    return;
  }

  const mode = process.env.SPIKE_MODE || 'normal';
  const providerModel = MODEL.slice('openrouter/'.length);
  // Hard-coded provider list for the OpenRouter endpoint. The OpenCode model
  // catalog is not used here: it can list a different set of models than
  // OpenRouter serves, and the runtime fetch is disabled anyway. Refresh the
  // entry from https://openrouter.ai/api/v1/models when the model changes.
  const config = {
    share: 'disabled',
    model: MODEL,
    small_model: MODEL,
    provider: {
      openrouter: {
        env: ['OPENROUTER_API_KEY'],
        options: { baseURL: process.env.SPIKE_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1' },
        whitelist: [providerModel],
        models: {
          [providerModel]: {
            name: process.env.SPIKE_MODEL_NAME || 'DeepSeek V4.1 Flash (OpenRouter)',
            limit:
              mode === 'compact'
                ? { context: 8000, output: 1024 }
                : { context: 128000, output: 8192 },
          },
        },
      },
    },
  };

  const name = `opencode-spike-${Date.now().toString(36)}`;
  const args = [
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '-e',
    'OPENROUTER_API_KEY',
    '-e',
    `OPENCODE_CONFIG_CONTENT=${JSON.stringify(config)}`,
    '-v',
    `${WORKDIR}:/workspace`,
    '-w',
    '/workspace',
    IMAGE,
    'opencode',
    'run',
    '--format',
    'json',
    '-m',
    MODEL,
    'Reply with exactly: tokyo-slice-ok',
  ];

  const result = spawnSync('podman', args, {
    env: { ...process.env, OPENROUTER_API_KEY: token },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  // A timeout or buffer failure kills the podman client, not the container;
  // the container would otherwise keep calling OpenRouter.
  if (result.error) {
    spawnSync('podman', ['rm', '-f', name], { encoding: 'utf8' });
  }

  const events = (result.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: 'unparsed', raw: line.slice(0, 120) };
      }
    });
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  const deltas = events
    .filter(event => event.type === 'part_delta')
    .map(event => [event.partType, event.delta]);
  const texts = events.filter(event => event.type === 'text').map(event => event.part?.text);
  const stdout = result.stdout || '';
  const compactionLeak =
    stdout.includes('Continue if you have next steps') || stdout.toLowerCase().includes('## objective');

  console.log(
    JSON.stringify(
      {
        mode,
        exit: result.status,
        timedOut: result.error?.code === 'ETIMEDOUT',
        bufferOverflow: result.error?.code === 'ENOBUFS',
        counts,
        deltas,
        texts,
        compactionLeak,
        stderrTail: (result.stderr || '').slice(-500),
      },
      null,
      2,
    ),
  );
};
