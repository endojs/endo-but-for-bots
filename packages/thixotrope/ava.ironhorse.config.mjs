import base from '../../ava-endo-lockdown.config.mjs';

// This explicit lane requires a built worker; the ordinary JS suite does not.
export default {
  ...base,
  files: [
    'test/ironhorse/scenarios.js',
    'test/ironhorse/reliability.js',
    'test/ironhorse/remote-delivery.js',
    'test/ironhorse/reachability.js',
    'test/ironhorse/supervisor.js',
    'test/ironhorse/mailbox.js',
    'test/ironhorse/http.js',
    'test/ironhorse/http-crash.js',
  ],
  timeout: '3m',
  concurrency: 1,
};
