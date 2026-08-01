import { expectTypeOf } from 'expect-type';
import type { WritableGitWorktree } from '@endo/exo-git';

import { makeGitMountTools } from '../src/json-tools/git-mount.js';
import type { GitMountToolCapability } from '../src/types.js';

// The mount bridge's `worktree()` must resolve to the same lineage-bearing
// `WritableGitWorktree` the underlying Git exposes; a bridge that widened or
// narrowed this return type would silently change what downstream mount
// tools can stage by entry.
expectTypeOf<
  Awaited<ReturnType<GitMountToolCapability['worktree']>>
>().toEqualTypeOf<WritableGitWorktree>();

// `makeGitMountTools` accepts only an eventual-send reference to a
// `GitMountToolCapability`, never the capability itself; a regression that
// let a bare (non-`ERef`) capability through would break the guest-facing
// invariant that every tool bridge takes its capability by eventual
// reference.
expectTypeOf<Parameters<typeof makeGitMountTools>[0]>().toEqualTypeOf<
  import('@endo/eventual-send').ERef<GitMountToolCapability>
>();
