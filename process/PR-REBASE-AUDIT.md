# PR Rebase Hygiene Audit -- endojs/endo-but-for-bots

Audited 60 open PRs against their respective base branches, snapshot at 2026-05-01T01:42:55Z.

All PR base branches resolve on the `bots` remote -- no PRs are orphaned by a deleted base.

## Green (16) -- rebased and linear

`behind == 0` and no merge commits in `base..head`. Already perfectly stacked.

- #21 | endor <- feat/make-archive | ahead=22 | makeArchive: source-only ZIP caplets alongside makeBundle
- #22 | endor <- slot-machine-pr | ahead=37 | feat(endo): slot-machine c-list manager with Rust daemon CI
- #23 | llm <- feature/edit-message | ahead=2 | feat(daemon): add editMessage and messageHistory
- #24 | llm <- dependabot/npm_and_yarn/all-minor-patch-a8ff424c68 | ahead=1 | chore: bump the all-minor-patch group across 1 directory with 37 updates
- #25 | llm <- jcorbin-rc | ahead=38 | Directional / CI smoking draft pr (draft)
- #26 | llm <- design/ci-no-npm-lifecycle | ahead=3 | ci: disable npm lifecycle scripts in workflows, add enforcement
- #29 | llm <- design/ocapn-tcp-syrup-framing | ahead=2 | feat(syrup-frame): add @endo/syrup-frame package (comma-less netstring variant)
- #30 | llm <- design/chat-slot-slash-commands | ahead=1 | docs(designs): add chat-slot-slash-commands design
- #31 | llm <- design/endor-tui | ahead=2 | feat(endor): add rust/endor TUI skeleton
- #32 | llm <- design/endor-bus-tui | ahead=3 | feat(tui,tui-xs): add endor TUI stub packages
- #49 | llm <- ocapn-noise-review-fixes | ahead=28 | feat(ocapn-noise): address security, ergonomics, portability review
- #50 | llm <- design/error-tracing-across-workers | ahead=2 | docs: design for tracing errors across CapTP workers (#1879)
- #51 | llm <- design/best-practices-from-review | ahead=1 | docs: distill PR-review best practices into CLAUDE.md and CONTRIBUTING.md
- #56 | design/endo-xorshift <- design/byteArray-codecs | ahead=3 | feat(marshal): admit immutable ArrayBuffer through codecs
- #58 | design/error-tracing-across-workers <- feat/error-tracing-implementation | ahead=7 | feat(daemon,cli): error tracing across CapTP workers (#1879)
- #72 | master <- design/issue-2834-bundlesource-cachesourcemaps | ahead=3 | fix(bundle-source): include cacheSourceMaps in options type (#2834)

## Needs rebase (36) -- clean fast-forward, no conflicts

`behind > 0`, `merge-tree` clean. A `git rebase bots/<base>` would land cleanly with no human input.

- #1 | llm <- dependabot/github_actions/actions/upload-artifact-6.0.0 | 717 behind, ahead=1 | chore: bump actions/upload-artifact from 5.0.0 to 6.0.0
  - Suggested action: `git rebase bots/llm` then force-push.
- #2 | llm <- dependabot/github_actions/actions/configure-pages-5.0.0 | 717 behind, ahead=1 | chore: bump actions/configure-pages from 4.0.0 to 5.0.0
  - Suggested action: `git rebase bots/llm` then force-push.
- #3 | llm <- dependabot/github_actions/actions/setup-python-6.2.0 | 717 behind, ahead=1 | chore: bump actions/setup-python from 5.6.0 to 6.2.0
  - Suggested action: `git rebase bots/llm` then force-push.
- #4 | llm <- dependabot/github_actions/actions/cache-5.0.3 | 717 behind, ahead=1 | chore: bump actions/cache from 4.3.0 to 5.0.3
  - Suggested action: `git rebase bots/llm` then force-push.
- #33 | llm <- review/2-lal-transcript-fix | 51 behind, ahead=2 | fix(lal): report broken transcript chains instead of silently truncating
  - Suggested action: `git rebase bots/llm` then force-push.
- #34 | llm <- review/2-locator-v2 | 51 behind, ahead=6 | refactor(daemon): migrate locator format to path-based V2
  - Suggested action: `git rebase bots/llm` then force-push.
- #35 | llm <- review/3-mount-core | 51 behind, ahead=7 | feat(daemon): mount Phase 4 — sub-mounts, snapshot, and capability VFS
  - Suggested action: `git rebase bots/llm` then force-push.
- #36 | llm <- review/3-platform-fs | 51 behind, ahead=10 | feat(platform): mutable File and Directory exos (Phase 4)
  - Suggested action: `git rebase bots/llm` then force-push.
- #37 | llm <- review/4-mount-extensions | 51 behind, ahead=16 | feat(daemon): mount extensions — revocation, deny patterns, glob/grep/stat/json
  - Suggested action: `git rebase bots/llm` then force-push.
- #38 | llm <- review/5-cli-assorted | 51 behind, ahead=9 | feat(cli): assorted CLI additions — workers, zip checkin/out, read-text, write-text
  - Suggested action: `git rebase bots/llm` then force-push.
- #39 | llm <- review/5-formula-introspection | 51 behind, ahead=6 | feat(daemon,cli): formula-type introspection — listWithTypes, inspect, workers tenants
  - Suggested action: `git rebase bots/llm` then force-push.
- #40 | llm <- review/6-agent-tools | 51 behind, ahead=19 | feat(daemon,cli): agent tools — interval scheduler, HTTP client, webhook endpoint
  - Suggested action: `git rebase bots/llm` then force-push.
- #41 | llm <- review/7-chat-inventory-dnd | 51 behind, ahead=5 | feat(chat): inventory drag-and-drop, cancel, type badges
  - Suggested action: `git rebase bots/llm` then force-push.
- #42 | llm <- review/7-chat-markdown-render | 51 behind, ahead=4 | feat(chat): per-message render mode toggle (Md/Raw/Pre)
  - Suggested action: `git rebase bots/llm` then force-push.
- #43 | llm <- review/7-chat-pending-commands | 51 behind, ahead=4 | feat(chat): pending commands region with unlocked command bar
  - Suggested action: `git rebase bots/llm` then force-push.
- #44 | llm <- review/7-chat-voice | 51 behind, ahead=3 | feat(chat): voice input via Web Speech API
  - Suggested action: `git rebase bots/llm` then force-push.
- #45 | llm <- review/7-command-messages | 51 behind, ahead=10 | feat(daemon,chat): commands-as-messages — record host commands in transcript
  - Suggested action: `git rebase bots/llm` then force-push.
- #46 | llm <- review/8-ocapn-network-separation | 51 behind, ahead=19 | refactor(ocapn): separate network from transport
  - Suggested action: `git rebase bots/llm` then force-push.
- #47 | llm <- review/9-docker-selfhost | 51 behind, ahead=7 | feat(docker,daemon): docker self-hosting — foreground daemon, CIDR gate, static files
  - Suggested action: `git rebase bots/llm` then force-push.
- #48 | llm <- review/10-design-loop-scaffolding | 51 behind, ahead=3 | docs: design loop scaffolding and unified-weblet-server revisions
  - Suggested action: `git rebase bots/llm` then force-push.
- #52 | master <- design/endo-xorshift | 19 behind, ahead=4 | feat(xorshift): add @endo/xorshift package
  - Suggested action: `git rebase bots/master` then force-push.
- #59 | master <- ocapn-noise-restaged-on-master | 19 behind, ahead=3 | feat(ocapn-noise): Noise IK netlayer for OCapN, restaged onto master
  - Suggested action: `git rebase bots/master` then force-push.
- #60 | master <- design/issue-390-intrinsics-test | 19 behind, ahead=1 | test(ses): replace deleted get-intrinsics test (closes #390)
  - Suggested action: `git rebase bots/master` then force-push.
- #62 | master <- kriskowal-random | 10 behind, ahead=2 | feat(random): add @endo/random ChaCha20-based seedable PRNG
  - Suggested action: `git rebase bots/master` then force-push.
- #73 | master <- kriskowal-rank-order-remotables-tied | 10 behind, ahead=2 | refactor(marshal): compareRankRemotablesTied for rank-cover ops
  - Suggested action: `git rebase bots/master` then force-push.
- #54 | master <- kriskowal-xorshift | 8 behind, ahead=4 | refactor(xorshift,hex,ocapn): consolidate xorshift PRNG via @endo/xorshift
  - Suggested action: `git rebase bots/master` then force-push.
- #63 | master <- design/issue-3081-cli-run-dead-code | 8 behind, ahead=1 | chore(cli): remove unreachable branch in run command (#3081)
  - Suggested action: `git rebase bots/master` then force-push.
- #64 | master <- design/issue-2632-harden-exports-pattern-makers | 8 behind, ahead=1 | feat(eslint-plugin): harden-exports skips M.* pattern makers (#2632)
  - Suggested action: `git rebase bots/master` then force-push.
- #65 | master <- design/issue-3052-patterns-copybag | 8 behind, ahead=1 | fix(patterns): handle copyBag in getRankCover kindMatcher (#3052)
  - Suggested action: `git rebase bots/master` then force-push.
- #66 | master <- design/issue-2749-eslint-require-param-ts | 8 behind, ahead=1 | chore(eslint): disable jsdoc/require-param for .ts files (#2749)
  - Suggested action: `git rebase bots/master` then force-push.
- #67 | master <- design/issue-2390-harden-exports-patterns | 8 behind, ahead=1 | fix(eslint-plugin): harden-exports handles destructuring patterns (#2390)
  - Suggested action: `git rebase bots/master` then force-push.
- #68 | master <- design/issue-2742-compartment-limits-doc | 8 behind, ahead=1 | docs(ses): document Compartment availability and OOM limits (#2742)
  - Suggested action: `git rebase bots/master` then force-push.
- #69 | master <- design/issue-3156-pass-style-document-all | 8 behind, ahead=1 | fix(pass-style): treat document.all-like values as objects (#3156)
  - Suggested action: `git rebase bots/master` then force-push.
- #70 | master <- design/issue-1845-bundler-no-name-diagnostic | 8 behind, ahead=2 | feat(compartment-mapper): diagnose package.json without a name (#1845)
  - Suggested action: `git rebase bots/master` then force-push.
- #71 | master <- design/issue-2879-env-options-per-compartment | 8 behind, ahead=2 | test(env-options,marshal): per-compartment options are scoped (#2879)
  - Suggested action: `git rebase bots/master` then force-push.
- #57 | master <- kriskowal-marshal-binary | 7 behind, ahead=2 | feat(marshal,pass-style): admit immutable ArrayBuffer through codecs
  - Suggested action: `git rebase bots/master` then force-push.

## Needs rebase with conflicts (6)

`behind > 0` and `git merge-tree` reports conflicts. Author intervention required.

- #7 | llm <- dependabot/npm_and_yarn/eslint-config-prettier-10.1.8 | 717 behind, ahead=1 | chore: bump eslint-config-prettier from 9.1.0 to 10.1.8
  - Conflicts in (sample): package.json, yarn.lock
- #9 | llm <- dependabot/npm_and_yarn/types/node-25.2.3 | 717 behind, ahead=1 | chore: bump @types/node from 20.17.24 to 25.2.3
  - Conflicts in (sample): package.json, yarn.lock
- #10 | llm <- dependabot/npm_and_yarn/eslint-plugin-jsdoc-62.5.5 | 717 behind, ahead=1 | chore: bump eslint-plugin-jsdoc from 50.6.1 to 62.5.5
  - Conflicts in (sample): yarn.lock
- #5 | llm <- dependabot/github_actions/changesets/action-1.7.0 | 682 behind, ahead=1 | chore: bump changesets/action from 1.6.0 to 1.7.0
  - Conflicts in (sample): .github/workflows/release.yml
- #27 | master <- design/base64-native-fallthrough | 27 behind, ahead=5 | feat(base64): dispatch to native Uint8Array base64 intrinsics
  - Conflicts in (sample): .changeset/base64-native-fallthrough.md, packages/base64/src/decode.js, packages/base64/src/encode.js, packages/base64/test/forced-polyfill.test.js
- #55 | master <- kriskowal-base64 | 8 behind, ahead=4 | feat(base64): hardened module + native ponyfill
  - Conflicts in (sample): packages/base64/src/decode.js

## Has merge commits (2)

`base..head` log contains at least one merge commit. The repo prefers linear-history rebase merges, so these usually indicate the author merged base into branch instead of rebasing -- but see notes for exceptions (long-lived feature branches with intentional merges).

- #8 | llm <- dependabot/npm_and_yarn/noble/hashes-2.0.1 | 1 merge commit(s), 682 behind, ahead=4 | chore: bump @noble/hashes from 1.8.0 to 2.0.1
  - Dependabot PR. Head branch contains a 1-commit dependency bump plus 3 leftover Claude-workflow commits (`Add Claude Code GitHub Workflow`, `"Claude Code Review workflow"`, `"Claude PR Assistant workflow"`). Recommend re-running Dependabot or rebuilding the branch from `bots/llm` with only the version bump.
- #17 | llm <- endor | 98 merge commit(s), 0 behind, ahead=662 | Rust endor supervisor: bus daemon, XS worker, CAS, debugger, npm registry
  - Note: `endor` is a long-lived feature branch that legitimately carries merge commits from upstream history (98 merges including `Merge remote-tracking branch 'actual/llm' into endor`). Not author misuse; treat as a stacked feature-branch PR rather than a rebasable PR.

## Stacked PRs (base is the head of another open PR)

None of these block the audit but they form chains where the parent PR's state matters.

- #21 (endor) -- depends on PR(s): #17
- #22 (endor) -- depends on PR(s): #17
- #56 (design/endo-xorshift) -- depends on PR(s): #52
- #58 (design/error-tracing-across-workers) -- depends on PR(s): #50

## Base branch not on bots (0)

Every open PR's `baseRefName` resolves to a branch on the `bots` remote. None to flag.

## Summary

| Category | Count |
| --- | --- |
| Green | 16 |
| Needs rebase (clean) | 36 |
| Needs rebase (conflicts) | 6 |
| Has merge commits | 2 |
| Base missing | 0 |

## Key recommendations

Of the 36 clean-rebase PRs, the seven oldest (#1-#5, #7, #9, #10) sit ~717 commits behind `bots/llm` -- they should either be rebased now or closed if abandoned, since the deeper they fall the higher the future conflict risk; #1-#4 and #7 still rebase cleanly, but #5, #9, and #10 already conflict. The 51-behind cluster (#43-#48) appears to share an `llm` base bump from the recent `Merge llm branches` commit and should rebase mechanically as a batch.

PR #8 (Dependabot noble/hashes bump) is contaminated with three stale Claude-workflow commits and should be regenerated rather than rebased; PR #17 (`endor` -> `llm`) is a long-lived feature branch whose merge commits are intentional and is *not* a rebase candidate. The four stacked PRs (#21, #22, #56, #58) should be reviewed once their parents land.
