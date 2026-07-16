# Live model eval report

- **campaign:** `live-eval-20260716t1426z`
- **suite:** `agentry-git-code-mode`
- **source SHA:** `c8aea294c7db6cdf55c29e32190ab04c9e2b2a2b`
- **run records:** 6

## Live model eval results

### conflict-rebase

| Model | Result | Transcript |
| --- | --- | --- |
| anthropic/claude-sonnet-5 | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | outcome failed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/google-gemini-2-5-flash-lite.md) |
| google/gemini-3.5-flash | provider error | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | outcome failed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/nvidia-nemotron-3-ultra-550b-a55b-free.md) |
| tencent/hy3:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/conflict-rebase/tencent-hy3-free.md) |

### stage-and-commit

| Model | Result | Transcript |
| --- | --- | --- |
| anthropic/claude-sonnet-5 | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | timed out | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/google-gemini-2-5-flash-lite.md) |
| google/gemini-3.5-flash | provider error | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | outcome failed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/nvidia-nemotron-3-ultra-550b-a55b-free.md) |
| tencent/hy3:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T142621Z+live-eval-20260716t1426z+c8aea294c7db/stage-and-commit/tencent-hy3-free.md) |

## Run records

| Started | Model | Status | Run ID |
| --- | --- | --- | --- |
| 2026-07-16T14:26:21Z | anthropic/claude-sonnet-5 | passed | `20260716T142621Z-garden-1041372-anthropic-claude-sonnet-5.EvxAk3` |
| 2026-07-16T14:27:19Z | deepseek/deepseek-v4-flash | passed | `20260716T142719Z-garden-1075745-deepseek-deepseek-v4-flash.jnObHc` |
| 2026-07-16T14:30:50Z | google/gemini-2.5-flash-lite | failed | `20260716T143050Z-garden-1205437-google-gemini-2.5-flash-lite.JKH6EN` |
| 2026-07-16T14:36:29Z | google/gemini-3.5-flash | failed | `20260716T143629Z-garden-1413837-google-gemini-3.5-flash.je1cal` |
| 2026-07-16T14:37:15Z | nvidia/nemotron-3-ultra-550b-a55b:free | failed | `20260716T143715Z-garden-1440660-nvidia-nemotron-3-ultra-550b-a55b-free.teuzsT` |
| 2026-07-16T14:39:32Z | tencent/hy3:free | passed | `20260716T143932Z-garden-1511611-tencent-hy3-free.gO5uhA` |

