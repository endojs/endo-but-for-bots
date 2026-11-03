---
'@endo/lal': minor
---

Add a host-only `/model` inbox command that switches a worker to another
provider or model between rounds, carrying the conversation forward. The
worker's auth token stays with the endpoint it was configured for, so a model
elsewhere needs its own credential in the daemon's environment.
