import { expectTypeOf } from 'expect-type';
import type { ReadOnlyEndoGit } from '@endo/exo-git';

import { makeGitMountTools } from '../src/json-tools/git-mount.js';
import type { GitMountToolCapability } from '../src/types.js';

// The separate maker retains only status so it can apply the agent-facing
// untracked-file default without requiring writable Git authority.
expectTypeOf<GitMountToolCapability>().toEqualTypeOf<
  Pick<ReadOnlyEndoGit, 'status'>
>();

// `makeGitMountTools` accepts only an eventual-send reference to a
// `GitMountToolCapability`, never the capability itself; a regression that
// let a bare (non-`ERef`) capability through would break the guest-facing
// invariant that every tool bridge takes its capability by eventual
// reference.
expectTypeOf<Parameters<typeof makeGitMountTools>[0]>().toEqualTypeOf<
  import('@endo/eventual-send').ERef<GitMountToolCapability>
>();
