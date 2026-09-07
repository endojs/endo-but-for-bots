import base from '../../ava-endo-lockdown.config.mjs';

// This explicit lane requires a built worker; the ordinary JS suite does not.
export default {
  ...base,
  files: [
    'test/ironhorse/scenarios.js',
    'test/ironhorse/reliability.js',
    'test/ironhorse/supervisor.js',
  ],
  timeout: '3m',
  concurrency: 1,
};
