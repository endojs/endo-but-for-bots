// @ts-check
// ESLint does not load under SES lockdown (it assigns to a frozen
// `constructor`), so the lint test runs it here, in a plain Node child.
// Input on stdin: {"cases": [code, ...]}. Output on stdout: JSON with the
// rule ids per case under the guest rules alone, the root config's rules for
// three files, and the messages of one root-config lint.
import path from 'node:path';
import url from 'node:url';

import { ESLint, Linter } from 'eslint';

import { guestRules } from '../lint/guest-rules.js';

const harnessRoot = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(harnessRoot, '..', '..');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { cases, rootText } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

const linter = new Linter({ configType: 'flat' });
const ids = cases.map((/** @type {string} */ code) =>
  linter
    .verify(code, [{ files: ['**/*.js'], ...guestRules }], 'guest/x/main.js')
    .map(message => message.ruleId ?? `fatal: ${message.message}`),
);

const eslint = new ESLint({ cwd: repoRoot });
const rulesFor = async (/** @type {string} */ file) => {
  const config = await eslint.calculateConfigForFile(file);
  return Object.keys(config.rules ?? {});
};
const guestFileRules = await rulesFor(
  'packages/thixotrope-harness/guest/session/main.js',
);
const fixtureFileRules = await rulesFor(
  'packages/thixotrope-harness/test/fixtures/guest/tiny/main.js',
);
const scriptFileRules = await rulesFor(
  'packages/thixotrope-harness/scripts/serve.mjs',
);
const rootRules = {
  guest: guestFileRules,
  fixture: fixtureFileRules,
  script: scriptFileRules,
};
// An existing guest file, so the typed-lint project service knows it; the
// text linted is `rootText`.
const [result] = await eslint.lintText(rootText, {
  filePath: path.join(
    harnessRoot,
    'test',
    'fixtures',
    'guest',
    'tiny',
    'main.js',
  ),
});
const rootLint = result.messages.map(m => ({
  ruleId: m.ruleId,
  fatal: m.fatal ?? false,
  message: m.message,
}));

process.stdout.write(JSON.stringify({ ids, rootRules, rootLint }));
