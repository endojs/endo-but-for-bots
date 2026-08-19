// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import * as exoGit from '@endo/exo-git';

test('exo-git public exports', t => {
  t.deepEqual(Object.keys(exoGit).sort(), [
    'BasicCredentialInterface',
    'BearerCredentialInterface',
    'GitCredentialControllerInterface',
    'GitInterface',
    'GitReaderInterface',
    'GitRemoteControllerInterface',
    'GitRemoteInterface',
    'GitRewriterInterface',
    'GitTreeInterface',
    'GitWriterInterface',
    'assertGitCredentialForUrl',
    'basicCredentialHelp',
    'bearerCredentialHelp',
    'getGitCredentialController',
    'getGitRemoteController',
    'gitBlobHelp',
    'gitCredentialControllerHelp',
    'gitHelp',
    'gitRemoteControllerHelp',
    'gitRemoteHelp',
    'gitTreeHelp',
    'isGitHistoryRewrite',
    'isGitReadOnly',
    'makeBasicCredential',
    'makeBearerCredential',
    'makeGit',
    'makeGitCloner',
    'makeGitFsBackend',
    'makeGitKit',
    'makeGitOperations',
    'makeGitRemote',
    'makeGitRemoteEndpoint',
    'makeHelp',
    'makeNotYetImplementedBackend',
    'makeUnavailableGitCredential',
    'normalizeGitRemotePolicy',
    'revokeGitCredential',
  ]);
});
