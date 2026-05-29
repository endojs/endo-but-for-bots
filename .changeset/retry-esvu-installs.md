---
'@endo/benchmark': patch
---

Retry esvu installs in install-engines.sh to ride out intermittent flakes
fetching the Moddable XS release on GitHub or the V8 canary build on
Google's chromium-v8 GCS bucket.
