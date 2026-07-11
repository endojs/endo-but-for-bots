---
'@endo/daemon': minor
---

Wire the AWS storage platform into a daemon flavour (phase 2 of
`designs/endo-daemon-aws-storage.md`). A new `makeDaemonicPowers`
variant (`src/daemon-aws-powers.js`) parallels the Node assembly but
takes an injected `DaemonDatabase` engine and content store, and a new
`src/daemon-aws.js` entry point dynamically imports the AWS SDK v3
(declared as optional peer dependencies), builds the DynamoDB and S3
client powers from environment configuration, and runs `makeDaemon`.
Two small shared touches make the seam injectable without a parallel
persistence module: the `DaemonDatabase.db` handle is now
engine-private (optional), and `makeDaemonicPersistencePowers` accepts
an injected content-store maker (defaulting to the filesystem store).
The daemon core is unchanged; the Node, XS, and Go flavours are
unaffected.
