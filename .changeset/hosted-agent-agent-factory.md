---
'@endo/hosted-agent': minor
'@endo/daemon': minor
---

New: an agent factory daemon caplet provisions and manages API-key guest agents bound to a configured inference provider.
It records the Lal or Fae harness each agent should run, but no harness turn runs yet: the responder that follows mail arrives separately.
The inference provider registry gains `listGrants`, and `InferenceProviderUse` gains `describe`.
Daemon directories, hosts, and guests gain `compareAndStoreIdentifier`, which changes one name only if it still holds the expected identifier.
