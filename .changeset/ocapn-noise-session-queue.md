---
'@endo/ocapn-noise': minor
---

Heartbeat sessions now queue outbound frames while the transport stalls and send them in order when it recovers.
`writer.next` returns once a frame is queued and waits only when 64 frames are queued.
`writer.return` sends the queued frames before closing.
Frames still queued when the session ends are dropped, and a `writer.next` still waiting for room returns `done`.
A transport write that stalls for the session timeout ends the session with an error, and transport write errors now surface through the reader.
`SessionLiveness` reports `lastSentNonce` and `queuedFrames`.
