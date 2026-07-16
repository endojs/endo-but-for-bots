# Live model eval report

> Transcript links include every attempt, including permitted retries.

Fresh rerun of the six-model campaign against PR #526 head
`c8aea294c7db6cdf55c29e32190ab04c9e2b2a2b`.

- **campaign:** `pr-526-live-eval-20260716t1600z`
- **suite:** `agentry-git-code-mode`
- **scenarios:** `stage-and-commit`, `conflict-rebase`
- **attempts:** 12 first-pass rows, plus 4 retry rows for two non-passing models
- **final result:** 4/6 models passed both scenarios, 8/12 final rows passed
- **setup:** `corepack yarn install --immutable` and the native `better-sqlite3` helper both exited 0
- **pricing:** persistent catalog cache reused, captured `2026-07-16T14:25:04Z`; total catalog-derived cost for final rows `$0.31683238`

## Live model eval results

### conflict-rebase

| Model | Result | Time | Tokens in / out / cache-read | Cost (catalog) | Turns | Tool calls / errors | Transcript |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anthropic/claude-sonnet-5 | ✅ passed | 34.7s | 78,030 / 2,009 / 0 | $0.17615000 | 9 | 8 / 1 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | ✅ passed | 49.7s | 33,110 / 1,754 / 42,240 | $0.00443336 | 14 | 13 / 2 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | ❌ outcome failed (retry 1/1) | 31.6s | 5,444 / 520 / 3,731 | $0.00078971 | 2 | 1 / 1 | [attempt 1](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/google-gemini-2-5-flash-lite--attempt-1.md) · [attempt 2](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/google-gemini-2-5-flash-lite--attempt-2.md) |
| google/gemini-3.5-flash | ✅ passed | 39.3s | 37,884 / 2,084 / 73,149 | $0.08655435 | 20 | 19 / 6 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | ❌ non-passing (retry 1/1) | 1m28.0s | 70,613 / 2,972 / 108,800 | $0.00000000 | 29 | 28 / 17 | [attempt 1](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/nvidia-nemotron-3-ultra-550b-a55b-free--attempt-1.md) · [attempt 2](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/nvidia-nemotron-3-ultra-550b-a55b-free--attempt-2.md) |
| tencent/hy3:free | ✅ passed | 1m46.9s | 14,629 / 2,509 / 190,208 | $0.00000000 | 32 | 31 / 8 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/conflict-rebase/tencent-hy3-free.md) |

Expected agent source: [`conflictRebaseSource`](https://github.com/endojs/endo-but-for-bots/blob/c8aea294c7db6cdf55c29e32190ab04c9e2b2a2b/packages/agentry/src/eval/scenarios/conflict-rebase/reference.js) - single-turn reference solution. Live runs are multi-turn and are not like-for-like transcripts.

### stage-and-commit

| Model | Result | Time | Tokens in / out / cache-read | Cost (catalog) | Turns | Tool calls / errors | Transcript |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anthropic/claude-sonnet-5 | ✅ passed | 6.6s | 14,246 / 184 / 0 | $0.03033200 | 2 | 1 / 0 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | ✅ passed | 19.1s | 15,324 / 659 / 8,192 | $0.00179476 | 5 | 4 / 2 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | ❌ outcome failed (retry 1/1) | 6.1s | 4,921 / 220 / 3,695 | $0.00061705 | 2 | 1 / 1 | [attempt 1](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/google-gemini-2-5-flash-lite--attempt-1.md) · [attempt 2](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/google-gemini-2-5-flash-lite--attempt-2.md) |
| google/gemini-3.5-flash | ✅ passed | 3.8s | 9,252 / 187 / 4,001 | $0.01616115 | 3 | 2 / 1 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | ❌ non-passing (retry 1/1) | 3.3s | 4,317 / 150 / 4,352 | $0.00000000 | 2 | 1 / 1 | [attempt 1](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/nvidia-nemotron-3-ultra-550b-a55b-free--attempt-1.md) · [attempt 2](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/nvidia-nemotron-3-ultra-550b-a55b-free--attempt-2.md) |
| tencent/hy3:free | ✅ passed | 5.2s | 4,419 / 175 / 4,032 | $0.00000000 | 2 | 1 / 0 | [transcript](https://github.com/endojs/endo-but-for-bots/blob/adfb005f8c1efdad03e42696fae697b193354e4d/20260716T160015Z+pr-526-live-eval-20260716t1600z+c8aea294c7db/stage-and-commit/tencent-hy3-free.md) |

Expected agent source: [`stageAndCommitSource`](https://github.com/endojs/endo-but-for-bots/blob/c8aea294c7db6cdf55c29e32190ab04c9e2b2a2b/packages/agentry/src/eval/scenarios/stage-and-commit/reference.js) - single-turn reference solution. Live runs are multi-turn and are not like-for-like transcripts.

## Failure Analysis

The failures are model/tool-use failures, not setup failures. The immutable install and native helper both exited 0, and every run used the same source SHA and campaign settings.

- **google/gemini-2.5-flash-lite:** both the first attempt and the one retry failed both scenarios. In `stage-and-commit`, it tried `git.add` with a plain `{ path: "README.md" }` value and received `copyRecord ... Must be a remotable`; a later commit attempt left `README.md` untracked. On the retry it also emitted `await is only valid in async functions and the top level bodies of modules`. In `conflict-rebase`, it first tried a bare `rebase` tool that was not available, then used `git.rebase` inconsistently and left the rebase unfinished. The outcome retained the initialization commit, reused pre-rebase commit IDs, omitted one or both notes, and did not produce the expected tree.
- **nvidia/nemotron-3-ultra-550b-a55b:free:** the first attempt passed `stage-and-commit` but failed `conflict-rebase`; the retry failed both. Its traces show the same capability-shape problems: `git.add` received a non-remotable path record, `git.rebase` was called with a string where a branch record was required, `git.branch` was attempted even though the exposed interface has no `branch` method, and several calls omitted the required `rebase.upstream`. The retry also ended with `ResourceExhausted: Worker local total request limit reached (33/32)`. Before that provider exhaustion, the outcome checks already showed the wrong replay history, wrong app wording, missing notes, and in one run an unfinished rebase.


Costs in the tables are calculated from emitted usage and the reused catalog rates. The provider-reported usage cost was zero, so it was not used for this report.
