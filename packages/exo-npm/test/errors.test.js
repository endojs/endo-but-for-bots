import test from '@endo/ses-ava/prepare-endo.js';

import {
  RegistryTamperedError,
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
  isRegistryError,
  registryErrorName,
} from '../src/errors.js';

test('RegistryTamperedError carries name and identifying message', t => {
  const err = RegistryTamperedError(
    'ses',
    '1.0.0',
    'sha512-AAAA',
    'sha256-BBBB',
  );
  t.true(err instanceof Error);
  t.is(registryErrorName(err), 'RegistryTamperedError');
  t.true(isRegistryError(err));
  // The four distinguishing values must be threaded through the
  // message so an operator reading the log can locate the failure
  // without consulting the assertion log.
  t.regex(err.message, /ses/);
  t.regex(err.message, /1\.0\.0/);
  t.regex(err.message, /sha512-AAAA/);
  t.regex(err.message, /sha256-BBBB/);
});

test('RegistryMissingPackageError tags missing-package class', t => {
  const err = RegistryMissingPackageError('lodash', '4.17.21');
  t.is(registryErrorName(err), 'RegistryMissingPackageError');
  t.true(isRegistryError(err));
  t.regex(err.message, /lodash/);
  t.regex(err.message, /4\.17\.21/);
});

test('RegistryNetworkError tags network class', t => {
  const err = RegistryNetworkError('connection refused');
  t.is(registryErrorName(err), 'RegistryNetworkError');
  t.true(isRegistryError(err));
  t.regex(err.message, /connection refused/);
});

test('RegistryOfflineError tags offline-miss class', t => {
  const err = RegistryOfflineError('ses', '2.0.0');
  t.is(registryErrorName(err), 'RegistryOfflineError');
  t.true(isRegistryError(err));
  t.regex(err.message, /offline/);
  t.regex(err.message, /ses/);
  t.regex(err.message, /2\.0\.0/);
});

test('isRegistryError returns false for non-registry errors', t => {
  t.false(isRegistryError(new Error('some other error')));
  t.false(isRegistryError(new TypeError('type error')));
  t.false(isRegistryError(undefined));
  t.false(isRegistryError(null));
  t.false(isRegistryError({ message: 'object pretending' }));
  t.false(isRegistryError('a string'));
  t.is(registryErrorName(new Error('plain')), undefined);
});

test('the four registry-error classes are distinguishable', t => {
  // The whole point of the structured errors: a caller branches on
  // class without inspecting message text. This test guards that
  // each class is identified distinctly.
  /** @type {Array<[Error, string]>} */
  const errors = [
    [RegistryTamperedError('p', '1', 'e', 'a'), 'RegistryTamperedError'],
    [RegistryMissingPackageError('p', '1'), 'RegistryMissingPackageError'],
    [RegistryNetworkError('reason'), 'RegistryNetworkError'],
    [RegistryOfflineError('p', '1'), 'RegistryOfflineError'],
  ];
  for (const [err, expected] of errors) {
    t.is(registryErrorName(err), expected);
  }
  // All four classes are distinct.
  const names = new Set(errors.map(([err]) => registryErrorName(err)));
  t.is(names.size, 4);
});
