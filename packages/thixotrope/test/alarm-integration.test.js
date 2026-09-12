// @ts-check
import test from '@endo/ses-ava/test.js';
import { registerAlarmIntegration } from './_alarm-integration.js';

registerAlarmIntegration(test, 'replay');
