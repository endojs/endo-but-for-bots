// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  BEGIN,
  END,
  buildReport,
  categorizeCommand,
  loadSession,
  renderMarkdown,
  replaceBlock,
  summariseRuns,
} from '../../scripts/process-time.mjs';
import { harnessRoot, scratch } from '../_helpers.js';

const run = promisify(execFile);
const script = path.join(harnessRoot, 'scripts', 'process-time.mjs');

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = s => new Date(T0 + s * 1000).toISOString();

const user = (s, content) => ({
  type: 'user',
  timestamp: at(s),
  message: { content },
});
const assistant = (s, content) => ({
  type: 'assistant',
  timestamp: at(s),
  message: { content },
});
const use = (s, id, name, input) =>
  assistant(s, [{ type: 'tool_use', id, name, input }]);
const result = (s, id, content = 'ok') =>
  user(s, [{ type: 'tool_result', tool_use_id: id, content }]);
const notify = (s, id) => ({
  type: 'attachment',
  timestamp: at(s),
  attachment: {
    type: 'queued_command',
    prompt: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
  },
});
const lines = records => `${records.map(r => JSON.stringify(r)).join('\n')}\n`;

const SECRET_WORD = 'zebra-marker-not-for-reports';

/**
 * A synthetic session: workflow "alpha" (finished, one agent that waits for
 * the run lock, edits, runs a background cargo build and polls for it) and
 * workflow "beta" (running, one agent holding the lock), plus a PM transcript
 * with a gap after both.
 * @param {string} root
 */
const writeSession = async root => {
  const dir = path.join(root, 'session');
  await mkdir(path.join(dir, 'workflows', 'scripts'), { recursive: true });
  await mkdir(path.join(dir, 'subagents', 'workflows', 'wf_a'), {
    recursive: true,
  });
  await mkdir(path.join(dir, 'subagents', 'workflows', 'wf_b'), {
    recursive: true,
  });
  await writeFile(
    path.join(dir, 'workflows', 'wf_a.json'),
    JSON.stringify({
      runId: 'wf_a',
      workflowName: 'thixotrope-harness-alpha',
      status: 'completed',
      startTime: T0,
      durationMs: 230_000,
      workflowProgress: [
        { type: 'workflow_agent', agentId: 'a1', label: 'unit one' },
      ],
    }),
  );
  await writeFile(
    path.join(dir, 'workflows', 'scripts', 'thixotrope-harness-beta-wf_b.js'),
    '// script\n',
  );
  await writeFile(
    path.join(dir, 'subagents', 'workflows', 'wf_b', 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', agentId: 'b1', label: 'unit two' })}\n`,
  );
  await writeFile(
    path.join(dir, 'subagents', 'workflows', 'wf_a', 'agent-a1.jsonl'),
    `${lines([
      user(0, `prompt ${SECRET_WORD}`),
      use(10, 'u1', 'Bash', {
        command: `node scripts/run-lock.mjs --label ${SECRET_WORD} -- yarn test`,
      }),
      result(
        70,
        'u1',
        'run-lock: {"event":"waiting","holder":null}\n1 test passed',
      ),
      use(100, 'u2', 'Edit', { file_path: `/${SECRET_WORD}/x.js` }),
      result(102, 'u2'),
      use(129, 'u3', 'Bash', {
        command: 'cargo build --release',
        run_in_background: true,
      }),
      result(130, 'u3', 'started in the background'),
      use(131, 'u4', 'Bash', {
        command: `until grep -q done ${SECRET_WORD}.log; do sleep 5; done`,
      }),
      notify(200, 'u3'),
      result(201, 'u4'),
      assistant(220, [{ type: 'text', text: `done ${SECRET_WORD}` }]),
    ])}{"type":"assistant","timestamp":"tor`,
  );
  await writeFile(
    path.join(dir, 'subagents', 'workflows', 'wf_b', 'agent-b1.jsonl'),
    lines([
      user(0, 'prompt'),
      use(0, 'v1', 'Bash', {
        command:
          'node scripts/run-lock.mjs --label perf -- node perf/x.perf.mjs',
      }),
      result(40, 'v1'),
      assistant(45, [{ type: 'text', text: 'done' }]),
    ]),
  );
  await writeFile(
    `${dir}.jsonl`,
    lines([
      user(-60, 'before the build'),
      user(5, 'owner'),
      assistant(10, [{ type: 'text', text: 'started' }]),
      user(230, 'notification'),
      assistant(235, [{ type: 'text', text: 'reading results' }]),
      assistant(300, [{ type: 'text', text: 'next workflow' }]),
    ]),
  );
  return dir;
};

test('categorizeCommand sorts commands into categories', t => {
  const c = s => categorizeCommand(s).category;
  t.is(
    c('cd x && node scripts/run-lock.mjs --label a -- yarn test'),
    'lockHold',
  );
  t.is(
    c(
      'THIX_HARNESS_INTEGRATION=1 corepack yarn ses-ava test/integration/a.test.js',
    ),
    'lockHold',
  );
  t.is(c('cargo build --release -p worker'), 'cargo');
  t.is(c('corepack yarn install --immutable'), 'deps');
  t.is(c('corepack yarn ses-ava test/unit/a.test.js'), 'tests');
  t.is(
    c('corepack yarn eslint a.js && corepack yarn prettier --write a.js'),
    'lint',
  );
  t.is(c('cd x && git add a.js && git commit -m msg'), 'git');
  t.is(c('cd x && grep -n foo a.js | head -5'), 'read');
  t.is(c('node tmp/w1/probe.mjs'), 'probe');
  t.is(c('mkdir -p x && cp a b'), 'shell');
  t.deepEqual(categorizeCommand('until ! pgrep -f cargo; do sleep 5; done'), {
    category: 'cargo',
    poll: true,
  });
  t.deepEqual(categorizeCommand('until grep -q x perf.log; do sleep 5; done'), {
    category: 'lockHold',
    poll: true,
  });
  t.deepEqual(
    categorizeCommand('for i in 1 2 3; do test -f y && break; sleep 5; done'),
    {
      category: 'idle',
      poll: true,
    },
  );
});

test('the report splits agent time by category from a synthetic session', async t => {
  const root = await scratch(t, 'pt');
  const dir = await writeSession(root);
  const session = await loadSession(dir);
  const report = buildReport(session, { now: T0 });

  t.deepEqual(
    report.workflows.map(w => [w.name, w.status, w.agents.length]),
    [
      ['alpha', 'completed', 1],
      ['beta', 'running', 1],
    ],
  );
  const [alpha, beta] = report.workflows;
  const a1 = alpha.agents[0];
  t.is(a1.label, 'unit one');
  t.is(a1.wallMs, 220_000);
  t.is(a1.split.lockWait, 30_000, 'waits until the other holder ends at 40 s');
  t.is(a1.split.lockHold, 30_000);
  t.is(a1.split.edit, 2000);
  t.is(
    a1.split.cargo,
    70_000,
    'the poll and the gap go to the background build',
  );
  t.is(a1.split.idle, 1000);
  t.is(a1.split.model, 87_000);
  t.is(
    Object.values(a1.split).reduce((s, v) => s + v, 0),
    a1.wallMs,
    'categories cover the wall time exactly',
  );
  t.is(a1.viaBackground, 70_000);

  t.is(beta.agents[0].label, 'unit two');
  t.is(beta.start, T0);
  t.is(beta.end, T0 + 45_000);
  t.is(beta.agents[0].split.lockHold, 40_000);
  t.is(beta.agents[0].split.model, 5000);

  t.is(report.buildMs, 300_000);
  t.is(report.coveredMs, 230_000);
  t.is(report.gaps.length, 1);
  t.is(report.gaps[0].ms, 70_000);
  t.is(report.gaps[0].pmMs, 70_000);
  t.is(report.gaps[0].after, 'alpha');
  t.is(
    report.lockBusyMs,
    70_000,
    'lock held 0-40 s (beta) and 40-70 s (alpha)',
  );
  t.is(report.agentMs, 265_000);
  t.is(report.longest[0].ms, 71_000, 'the background build is the longest');
  t.is(report.longest[0].category, 'cargo');
  t.true(report.longest[0].background);
  t.is(report.pmSplit?.split.idle, 220_000);

  const md = renderMarkdown(report);
  t.false(md.includes(SECRET_WORD), 'no command, prompt or message text');
  t.false(md.includes(root), 'no paths');
  t.regex(md, /\| alpha \| completed \|/);
  t.regex(md, /waiting for the run lock/);
});

test('summariseRuns groups run-lock log lines by lane', t => {
  const s = summariseRuns([
    { lane: 'a', waitedMs: 10, heldMs: 100, exitCode: 0 },
    { lane: 'a', waitedMs: 5, heldMs: 300, exitCode: 1, timedOut: true },
    { lane: 'b', waitedMs: 0, heldMs: 50, exitCode: 0 },
    { lane: 'b', waitedMs: 0, heldMs: 20, exitCode: null },
    'not a record',
  ]);
  t.deepEqual(s, [
    {
      lane: 'a',
      runs: 2,
      waitedMs: 15,
      heldMs: 400,
      timedOut: 1,
      failed: 1,
      maxHeldMs: 300,
    },
    {
      lane: 'b',
      runs: 2,
      waitedMs: 0,
      heldMs: 70,
      timedOut: 0,
      failed: 0,
      maxHeldMs: 50,
    },
  ]);
});

test('replaceBlock rewrites only the generated block', t => {
  const first = replaceBlock('# Title\n\nIntro.\n', 'one');
  t.is(first, `# Title\n\nIntro.\n\n${BEGIN}\none\n${END}\n`);
  const edited = `${first}\n## Findings\n\nKept.\n`;
  const second = replaceBlock(edited, 'two');
  t.is(
    second,
    `# Title\n\nIntro.\n\n${BEGIN}\ntwo\n${END}\n\n## Findings\n\nKept.\n`,
  );
  t.is(replaceBlock('', 'x'), `${BEGIN}\nx\n${END}\n`);
});

test('the CLI writes the block and reads the run log from THIX_HARNESS_HOME', async t => {
  const root = await scratch(t, 'pc');
  const dir = await writeSession(root);
  const home = path.join(root, 'home');
  await mkdir(home);
  await writeFile(
    path.join(home, 'runs.jsonl'),
    `${JSON.stringify({ lane: 'lane-x', waitedMs: 2000, heldMs: 60_000, exitCode: 0 })}\n{torn`,
  );
  const out = path.join(root, 'TIMELOG.md');
  await writeFile(out, '# Log\n\nBefore.\n');
  await run(process.execPath, [script, dir, '--out', out], {
    env: { ...process.env, THIX_HARNESS_HOME: home },
  });
  const text = await readFile(out, 'utf8');
  t.true(text.startsWith('# Log\n\nBefore.\n'));
  t.regex(text, /\| lane-x \| 1 \| 2s \| 1m 00s \|/);
  t.false(text.includes(SECRET_WORD));

  const missing = await run(process.execPath, [script], {
    env: { ...process.env, THIX_PROCESS_SESSION_DIR: '' },
  }).catch(error => error);
  t.is(missing.code, 2, 'no session directory is a usage error');
});
