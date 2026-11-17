---
'@endo/lal': minor
---

Lal now keeps a Pi-compatible JSONL transcript of each worker's session in a
daemon scratch mount named `transcripts-for-lal`. On restart a worker resumes
its newest session file, repairing a torn tail, and seeds its PiAgent from the
recorded messages. Only the Lal harness holds the writable mount; worker
sub-guests, whose powers the model's tools use, are never introduced to it.
