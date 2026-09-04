// @ts-check

export {
  makeGit,
  makeGitKit,
  makeGitOperations,
  isGitHistoryRewrite,
  isGitReadOnly,
  makeNotYetImplementedBackend,
} from './git.js';

export { makeGitFsBackend } from './git-filesystem.js';

export {
  makeGitRemoteEndpoint,
  makeGitRemote,
  getGitRemoteController,
} from './git-remote.js';

export { normalizeGitRemotePolicy } from './git-remote-policy.js';

export { makeGitCloner } from './git-cloner.js';

export {
  makeBasicCredential,
  makeBearerCredential,
  makeUnavailableGitCredential,
  assertGitCredentialForUrl,
  revokeGitCredential,
  getGitCredentialController,
} from './git-credential.js';

export {
  basicCredentialHelp,
  bearerCredentialHelp,
  gitCredentialControllerHelp,
  gitBlobHelp,
  gitHelp,
  gitRemoteControllerHelp,
  gitRemoteHelp,
  gitTreeHelp,
  makeHelp,
} from './help-text.js';

export {
  GitInterface,
  GitReaderInterface,
  GitWriterInterface,
  GitRewriterInterface,
  GitTreeInterface,
  GitRemoteInterface,
  GitRemoteControllerInterface,
  GitCredentialControllerInterface,
  BasicCredentialInterface,
  BearerCredentialInterface,
} from './interfaces.js';
