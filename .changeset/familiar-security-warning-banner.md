---
'@endo/chat': minor
'@endo/familiar': patch
---

Chat now shows a dismissible banner when the Familiar cannot confirm one of its exfiltration defenses at startup.
The Familiar delivers these warnings whenever the Chat page loads, so a slow first load or a daemon-restart reload no longer loses them, and it does not send them to weblet pages loaded into the same window.
