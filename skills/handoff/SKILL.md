---
name: handoff
description: Write a handoff document of the current conversation so a fresh session can continue the work. Run by the context bar's handoff button.
argument-hint: "Where to save it, and what the next session will focus on"
disable-model-invocation: true
---

Write a handoff document that lets a fresh session, with none of this conversation in its context, continue the work.

- Save it where the arguments say, at exactly that path. With no path given, save it in the OS temp directory, never in the workspace. Reply with the path.
- Cover the goal, what is done and verified, what is not verified yet, the decisions made and why, the gotchas learned, the files and commands that matter, and the next steps in order.
- Point to existing artifacts (files, specs, issues, commits, pull requests) by path or URL instead of copying them.
- Leave out secrets: API keys, tokens, passwords and personal data.
- If the arguments say what the next session is for, focus the document on that.
