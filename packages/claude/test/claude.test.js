import test from '@endo/ses-ava/prepare-endo.js';

import {
  buildClaudeArgv,
  buildClaudeEnv,
  makeStreamReducer,
  classifyStreamEvent,
} from '../index.js';

test('argv carries the confinement recipe and no prompt', t => {
  const argv = buildClaudeArgv({
    mcpConfigPath: '/turn/mcp.json',
    toolNames: ['writeText', 'readText'],
    maxTurns: 3,
  });
  t.true(argv.includes('--bare'));
  t.is(argv[argv.indexOf('--tools') + 1], '');
  t.is(argv[argv.indexOf('--setting-sources') + 1], '');
  t.is(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  t.is(
    argv[argv.indexOf('--allowedTools') + 1],
    'mcp__guest__writeText,mcp__guest__readText',
  );
  t.throws(() =>
    buildClaudeArgv({ mcpConfigPath: 'x', toolNames: ['a,b'], maxTurns: 1 }),
  );
});

test('env is constructed, not inherited', t => {
  const env = buildClaudeEnv({ home: '/h', configDir: '/c', bearer: 'tok' });
  t.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CONFIG_DIR',
    'DISABLE_AUTOUPDATER',
    'HOME',
    'PATH',
  ]);
});

const authRetry = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  error_status: 401,
  error: 'authentication_failed',
};

test('needs-auth only from a pinned version', t => {
  t.deepEqual(classifyStreamEvent('2.1.280', authRetry), { type: 'needs-auth' });
  t.is(classifyStreamEvent('9.9.9', authRetry), undefined);
  t.is(classifyStreamEvent(undefined, authRetry), undefined);
});

test('reducer splits chunks and classifies from the init version', t => {
  const reducer = makeStreamReducer();
  const init = JSON.stringify({
    type: 'system',
    subtype: 'init',
    claude_code_version: '2.1.278',
  });
  const text = `${init}\nnot json\n${JSON.stringify(authRetry)}\n`;
  reducer.push(text.slice(0, 17));
  reducer.push(text.slice(17));
  reducer.end();
  const snap = reducer.snapshot();
  t.is(snap.events, 2);
  t.is(snap.malformed, 1);
  t.deepEqual(snap.classified, { type: 'needs-auth' });
});
