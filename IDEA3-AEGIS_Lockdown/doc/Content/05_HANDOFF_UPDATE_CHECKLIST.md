# Handoff Update Checklist

Use this checklist whenever updating `04_SESSION_HANDOFF.md`.

## Always capture

- current date/time
- repository root
- Git branch
- HEAD SHA
- `git status --short`
- files changed
- architectural decisions
- security implications
- exact test commands/results
- failures and root causes
- known untested behavior
- exact next step

## Before a context/token boundary
If the conversation is long or context capacity may be running low:

1. Do not start another large edit.
2. Save modified files.
3. Run the smallest useful validation that can finish safely.
4. Capture Git state.
5. Update `04_SESSION_HANDOFF.md`.
6. Verify with:

```bash
sed -n '1,260p' doc/Content/04_SESSION_HANDOFF.md
```

7. If the handoff contains placeholders for facts already known, fill them.
8. Never include secret values.
9. End the chat turn with a short note that the handoff is current and where to resume.

## Recommended proactive cadence
Do not wait for an exact token counter. Update the handoff:

- after a major feature,
- after a refactor,
- after a meaningful test cycle,
- after a blocker is discovered/resolved,
- every few meaningful edits during long autonomous work.
