import type { ERef } from '@endo/eventual-send';
import { expectTypeOf } from 'expect-type';

import { makeGitHistoryTool, makeGitTool } from '../src/json-tools/git.js';
import type {
  GitHistoryToolCapability,
  GitToolRewriterCapability,
  GitToolWriterCapability,
} from '../src/types.js';

// `yarn workspace @endo/agent-tools test:types` compiles this fixture through
// tsconfig.test-types.json. The legacy history name must retain exactly its
// four-method capability instead of expanding to the complete rewriter facet.
type ExpectedHistoryToolCapability = Pick<
  GitToolRewriterCapability,
  'commit' | 'reword' | 'cherryPick' | 'rebase'
>;

expectTypeOf<GitHistoryToolCapability>().toEqualTypeOf<ExpectedHistoryToolCapability>();
expectTypeOf<GitHistoryToolCapability>().not.toEqualTypeOf<GitToolRewriterCapability>();
expectTypeOf<Parameters<typeof makeGitHistoryTool>[0]>().toEqualTypeOf<
  ERef<GitHistoryToolCapability>
>();

declare const writerGit: ERef<GitToolWriterCapability>;
declare const rewriterGit: ERef<GitToolRewriterCapability>;
declare const historyGit: ERef<GitHistoryToolCapability>;

makeGitHistoryTool(historyGit);
makeGitHistoryTool(rewriterGit);
makeGitTool(rewriterGit, { facet: 'rewriter' });

// The narrow compatibility capability does not pretend to carry the reader
// and writer methods in the complete rewriter-facet catalog.
// @ts-expect-error A history-only capability cannot construct the full catalog.
makeGitTool(historyGit, { facet: 'rewriter' });

// The compatibility maker preserves the authority boundary of the rewriter
// facet; keeping the old export must not make a writer capability sufficient.
// @ts-expect-error A writer facet cannot construct the rewriter catalog.
makeGitHistoryTool(writerGit);
// @ts-expect-error The primary maker enforces the same facet/capability match.
makeGitTool(writerGit, { facet: 'rewriter' });
