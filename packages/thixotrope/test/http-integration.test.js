// @ts-check
import test from '@endo/ses-ava/test.js';
import { registerHttpIntegration } from './_http-integration.js';

registerHttpIntegration(test, 'replay');
