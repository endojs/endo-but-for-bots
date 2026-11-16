// @ts-check
/* global process */
import '@endo/init';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { makeClaudeSubscriptionLogin } from './src/subscription-login.js';

// node packages/claude-sandbox/login.js /private/path/login.json primary-oauth
const [, , output, accountRef = 'primary-oauth'] = process.argv;
if (!output || process.argv.length > 4)
  throw Error('Usage: node login.js OUTPUT_FILE [ACCOUNT_BINDING]');
// Exclusive, owner-only output reserved before sending any one-use code.
const file = await open(output, 'wx', 0o600);
// Suppress readline's TTY echo, including redraws containing pasted codes.
let hidden = false;
const outputStream = new Writable({
  write(chunk, encoding, done) {
    if (!hidden) process.stdout.write(chunk, encoding);
    done();
  },
});
const terminal = createInterface({
  input: process.stdin,
  output: outputStream,
  terminal: Boolean(process.stdin.isTTY),
});
try {
  const login = makeClaudeSubscriptionLogin({ accountRef });
  console.log(
    'Open this link and sign in to the intended Claude subscription:',
  );
  console.log(login.authorizationUrl);
  process.stdout.write(
    'Paste the code#state shown after authorization (hidden): ',
  );
  hidden = true;
  const reply = await terminal.question('');
  terminal.close();
  process.stdout.write('\n');
  const record = await login.exchange(reply);
  await file.writeFile(`${JSON.stringify(record)}\n`);
  await file.sync();
  console.log(
    'Saved renewal credential to the private output file. Import it into Secrets, then remove the file.',
  );
} finally {
  terminal.close();
  await file.close();
}
