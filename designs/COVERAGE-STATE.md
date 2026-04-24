# Coverage Loop State

| | |
|---|---|
| **Last Run** | 2026-04-16 |
| **Package** | @endo/base64 |
| **Line Coverage** | 95.73% → 96.68% |
| **Branch Coverage** | 89.18% → 92.10% |
| **Action Taken** | Added test for `btoa` error path (non-Latin1 characters), bringing `btoa.js` from 88% to 100% lines. Remaining uncovered code is XS-engine-only adapter (`src/decode.js:72-77`) and unreachable defensive assertion (`src/encode.js:60`) — both untestable in Node.js. |
| **Next Package** | @endo/cache-map |
