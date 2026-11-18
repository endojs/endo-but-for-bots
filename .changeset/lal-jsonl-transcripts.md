---
'@endo/lal': minor
---

Lal now keeps a Pi-compatible JSONL transcript of each worker's session in a
daemon scratch mount named `transcripts-for-lal`. On restart a worker resumes
its newest session file and seeds its PiAgent from the recorded messages.
