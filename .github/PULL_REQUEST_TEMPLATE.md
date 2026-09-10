<!-- collaboration-policy
area: replace-me
owner: replace-me
integration-review: no
-->

<!--
Valid areas: idea1 | idea2 | idea3 | infrastructure | shared
Valid owners: kla | pub | music
Set integration-review to yes whenever this PR changes another area's files or shared surfaces.
Do not delete the collaboration-policy block.
-->

## Summary

- What outcome does this Pull Request deliver?
- Why is the change needed?

## Source files changed

- List the important application/configuration paths and what changed in each.

## Verification

- `exact command` — pass/fail result and count where available.

## Obsidian receipt

- Pending — task still Draft/in progress.

<!--
A Draft multi-session task PR may have no final receipt yet. At final task
handoff, replace Pending with the one immutable receipt path before marking the
PR Ready/non-Draft. A Draft may also contain that one valid final receipt while
awaiting the human Ready transition.
-->

## Canonical notes updated

- List the owner-writable IDEA/Infrastructure notes updated with current facts.
- Write `None — receipt only; canonical facts did not change` when appropriate.

## Shared surfaces touched

None

<!--
If integration-review is yes, replace None with every exact cross-scope path and its reason.
Examples: gateway/nginx.conf, docker-compose.yml, shared/db-schema/init.sql.
-->

## Integration requests

None

<!-- Name any owner-only Core note that must be reconciled after merge. -->

## Known limitations

None

## Reviewer checklist

- [ ] Scope and policy metadata match the actual changed paths.
- [ ] Tests are reproducible and results are recorded honestly.
- [ ] Draft/in-progress receipt status is truthful; a Draft may contain zero or
      one final receipt.
- [ ] If Ready/non-Draft, exactly one valid immutable final task receipt is included.
- [ ] Shared changes are explicitly listed and integration-reviewed.
- [ ] No secrets, `.env`, credentials, tokens, recordings, or generated dependencies are included.
- [ ] The branch was updated from current `main` after any competing PR merged.
