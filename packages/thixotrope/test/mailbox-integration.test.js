// @ts-check
import test from '@endo/ses-ava/test.js';
import { registerMailboxIntegration } from './_mailbox-integration.js';

registerMailboxIntegration(test, 'replay');
