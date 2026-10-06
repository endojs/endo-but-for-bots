---
'@endo/chat': minor
'@endo/familiar': minor
---

Chat now shows a dismissible banner when the Familiar cannot confirm one of its exfiltration defenses at startup.
The Familiar delivers these warnings whenever the Chat page loads, so a slow first load or a daemon-restart reload no longer loses them, and it sends them only to the Chat page itself, not to weblets or other pages loaded into the same window.
The Familiar re-checks the defenses before a daemon restart or purge reloads the Chat page, and when a window is reopened from the dock on macOS, rather than reusing the result from launch.
