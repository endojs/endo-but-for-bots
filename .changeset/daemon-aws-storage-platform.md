---
'@endo/daemon': minor
---

Add an experimental AWS storage platform for the daemon, designed in
`designs/endo-daemon-aws-storage.md`: `makeDaemonDatabaseAws`
(`src/daemon-database-aws.js`), a third engine behind the
`DaemonDatabase` interface that serves the synchronous surface from an
in-memory mirror and flushes to DynamoDB through a write-behind queue,
and `makeS3ContentStore` (`src/content-store-s3.js`), the
`ContentStore` contract over S3 with `size` and ranged reads. The
engines consume narrow injected client powers; the AWS SDK adapters
(`src/daemon-aws-sdk.js`) receive the SDK v3 module namespaces as
parameters, so `@endo/daemon` takes no AWS dependency and no ambient
authority. The daemon core is unchanged; flavour wiring is a
follow-up phase.
