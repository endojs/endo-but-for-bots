// @ts-check

import { M } from '@endo/patterns';

import { NameOrPathShape } from '../type-guards.js';

export const StringListShape = M.arrayOf(M.string());
harden(StringListShape);

export const MountProvisionShape = M.splitRecord(
  { path: M.string() },
  { readOnly: M.boolean(), deniedSegments: StringListShape },
  {},
);
harden(MountProvisionShape);

export const GitProvisionShape = M.splitRecord(
  { mount: M.string(), path: StringListShape },
  { readOnly: M.boolean(), allowHistoryRewrite: M.boolean() },
  {},
);
harden(GitProvisionShape);

export const GitRemoteProvisionShape = M.splitRecord(
  { git: M.string(), name: M.string(), url: M.string() },
  {
    allowedDirections: M.arrayOf(M.or('fetch', 'push')),
    fetchRefspecs: StringListShape,
    pushRefspecs: StringListShape,
    defaultPullRef: M.string(),
    allowedBranches: StringListShape,
    allowForcePush: M.boolean(),
    allowTags: M.boolean(),
    allowDelete: M.boolean(),
    allowLocalFileTransport: M.boolean(),
    credential: NameOrPathShape,
  },
  {},
);
harden(GitRemoteProvisionShape);

/**
 * A neutral named capability graph. Every property key is the binding the
 * guest receives; dependency fields name keys in the selected category.
 */
export const EndoGuestAuthorityShape = M.splitRecord(
  {},
  {
    mount: M.recordOf(M.string(), MountProvisionShape),
    git: M.recordOf(M.string(), GitProvisionShape),
    gitRemote: M.recordOf(M.string(), GitRemoteProvisionShape),
  },
  {},
);
harden(EndoGuestAuthorityShape);

export const MakeGuestOptionsShape = M.splitRecord(
  {},
  {
    agentName: NameOrPathShape,
    introducedNames: M.recordOf(M.string(), M.string()),
    authority: EndoGuestAuthorityShape,
  },
  {},
);
harden(MakeGuestOptionsShape);
