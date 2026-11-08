// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { main } from '../setup-direct.js';

test('invalid Anthropic pool credential configuration fails before publishing capabilities', async t => {
  const host = Far('Host', {});
  await t.throwsAsync(
    main(host, {
      env: {
        ENDO_CLAUDE_ACCOUNT_AUTHORITY: 'claude-pool',
        ENDO_CLAUDE_CREDS_KIND: 'apiKey',
        ENDO_CLAUDE_SUBSCRIPTIONS: JSON.stringify([
          { id: 'one', credsName: 'claude-token' },
        ]),
      },
    }),
    { message: /require OAuth/ },
  );
});
