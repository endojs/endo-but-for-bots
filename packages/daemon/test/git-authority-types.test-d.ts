import { expectTypeOf } from 'expect-type';
import type {
  EndoGit,
  HistoryRewriteEndoGit,
  ReadOnlyEndoGit,
  ReadWriteEndoGit,
} from '@endo/exo-git';

import type { EndoHost, EndoMount, GitProvisionOptions } from '../src/types.js';

declare const host: EndoHost;
declare const mount: EndoMount;
declare const allowHistoryRewrite: boolean;
declare const optionsSelectedAtRuntime: GitProvisionOptions;

const ordinary = host.provideGit(mount, 'ordinary');
const explicitOrdinary = host.provideGit(mount, 'explicit-ordinary', {
  allowHistoryRewrite: false,
});
const historyRewrite = host.provideGit(mount, 'history-rewrite', {
  allowHistoryRewrite: true,
});
const selectedAtRuntime = host.provideGit(mount, 'selected-at-runtime', {
  allowHistoryRewrite,
});
const optionsSelectedAtRuntimeResult = host.provideGit(
  mount,
  'options-selected-at-runtime',
  optionsSelectedAtRuntime,
);
const readOnly = host.provideGit(mount, 'read-only', { readOnly: true });
const readOnlyIgnoresHistoryRewrite = host.provideGit(
  mount,
  'read-only-ignores-history-rewrite',
  { readOnly: true, allowHistoryRewrite: true },
);

// `provideGit`'s overloads pin the caller's `allowHistoryRewrite` argument to
// its provisioned posture: omitting the option, or passing it as `false`, is
// the only path to `ReadWriteEndoGit`. If an overload regressed to widen the
// ordinary path's return type, a guest holding an `ordinary` grant would
// appear to gain `reword` / `cherryPick` / `rebase` at the type level even
// though the daemon never grants that authority for it, silently degrading
// the git-authority-types contract this fixture exists to hold static callers
// to.
expectTypeOf(ordinary).resolves.toEqualTypeOf<ReadWriteEndoGit>();
expectTypeOf(explicitOrdinary).resolves.toEqualTypeOf<ReadWriteEndoGit>();

// `allowHistoryRewrite: true` is the only literal that selects the elevated
// overload. A regression here would mean a caller who explicitly asked for
// history-rewrite authority instead gets typed back as an ordinary
// `ReadWriteEndoGit`, hiding the `reword` / `cherryPick` / `rebase` methods
// from every downstream consumer that trusts the static type.
expectTypeOf(historyRewrite).resolves.toEqualTypeOf<HistoryRewriteEndoGit>();

// When `allowHistoryRewrite` is a plain `boolean` decided at runtime rather
// than a literal, the overload set cannot pick a single posture ahead of
// time, so the honest static type is the union of both. Collapsing this
// union to either arm alone would either over-promise history-rewrite
// methods on an ordinary grant or hide them on an elevated one.
expectTypeOf(selectedAtRuntime).resolves.toEqualTypeOf<
  ReadWriteEndoGit | HistoryRewriteEndoGit
>();
// When the whole options bag (not just one boolean field) is decided at
// runtime, a `GitProvisionOptions` value may carry `readOnly: true` as well as
// either `allowHistoryRewrite`, so the honest static type is every posture.
expectTypeOf(optionsSelectedAtRuntimeResult).resolves.toEqualTypeOf<EndoGit>();

// `readOnly: true` is persisted in the formula and selects the reader facet
// over any mount, overriding `allowHistoryRewrite`.  The type must drop every
// mutation method: a caller that hands this result to an auditor relies on
// the static type to know the auditor cannot commit, stage, switch branches,
// merge, rebase, or touch the stash.
expectTypeOf(readOnly).resolves.toEqualTypeOf<ReadOnlyEndoGit>();
expectTypeOf(
  readOnlyIgnoresHistoryRewrite,
).resolves.toEqualTypeOf<ReadOnlyEndoGit>();

// `provideGitClone` always constructs a fresh, unrewritten repository, so its
// `git` facet can never carry history-rewrite authority regardless of any
// option a caller supplies. A consumer that clones expecting `reword` /
// `cherryPick` / `rebase` to be typed away would notice immediately if this
// pin regressed to `HistoryRewriteEndoGit` or widened to the union above.
type CloneResult = Awaited<ReturnType<EndoHost['provideGitClone']>>;
expectTypeOf<CloneResult['git']>().toEqualTypeOf<ReadWriteEndoGit>();
