# Live model eval report

- **campaign:** `live-eval-20260716t1321z`
- **suite:** `agentry-git-code-mode`
- **source SHA:** `5f6455e4c5cf9dfc9b13b12aecc20bf89e0e8e58`
- **run records:** 8

## Live model eval results

### conflict-rebase

| Model | Result | Transcript |
| --- | --- | --- |
| anthropic/claude-sonnet-5 | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | outcome failed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/google-gemini-2-5-flash-lite.md) |
| google/gemini-3.5-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/nvidia-nemotron-3-ultra-550b-a55b-free.md) |
| tencent/hy3:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/conflict-rebase/tencent-hy3-free.md) |

### stage-and-commit

| Model | Result | Transcript |
| --- | --- | --- |
| anthropic/claude-sonnet-5 | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/anthropic-claude-sonnet-5.md) |
| deepseek/deepseek-v4-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/deepseek-deepseek-v4-flash.md) |
| google/gemini-2.5-flash-lite | outcome failed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/google-gemini-2-5-flash-lite.md) |
| google/gemini-3.5-flash | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/google-gemini-3-5-flash.md) |
| nvidia/nemotron-3-ultra-550b-a55b:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/nvidia-nemotron-3-ultra-550b-a55b-free.md) |
| tencent/hy3:free | passed | [transcript](https://github.com/endojs/endo-but-for-bots/blob/eb3d6736fe3bb15fc9df44ea4b879e875facccb1/20260716T132132Z+live-eval-20260716t1321z+5f6455e4c5cf/stage-and-commit/tencent-hy3-free.md) |

## Run records

| Started | Model | Status | Run ID |
| --- | --- | --- | --- |
| 2026-07-16T13:21:32Z | tencent/hy3:free | failed | `20260716T132132Z-garden-2676648-tencent-hy3-free.COASX9` |
| 2026-07-16T13:21:42Z | tencent/hy3:free | interrupted | `20260716T132142Z-garden-2684958-tencent-hy3-free.J3LUhZ` |
| 2026-07-16T13:22:21Z | tencent/hy3:free | passed | `20260716T132221Z-garden-2703457-tencent-hy3-free.7xhmQr` |
| 2026-07-16T13:23:36Z | nvidia/nemotron-3-ultra-550b-a55b:free | passed | `20260716T132336Z-garden-2744018-nvidia-nemotron-3-ultra-550b-a55b-free.rEsbs8` |
| 2026-07-16T13:27:44Z | anthropic/claude-sonnet-5 | passed | `20260716T132744Z-garden-2896470-anthropic-claude-sonnet-5.zmD68S` |
| 2026-07-16T13:28:49Z | deepseek/deepseek-v4-flash | passed | `20260716T132849Z-garden-2936869-deepseek-deepseek-v4-flash.33BEO5` |
| 2026-07-16T13:31:26Z | google/gemini-2.5-flash-lite | failed | `20260716T133126Z-garden-3036102-google-gemini-2.5-flash-lite.YQ29MK` |
| 2026-07-16T13:32:08Z | google/gemini-3.5-flash | passed | `20260716T133208Z-garden-3061326-google-gemini-3.5-flash.WazFTr` |

