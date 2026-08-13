# Claude Code Instructions for AEGIS

Read and follow repository-root `AGENTS.md` before every task. It is the
canonical workflow for ownership, branch scope, testing, Pull Requests, and
the mandatory Obsidian task receipt.

Never push directly to `main`. Use one task branch and one Pull Request. Every
completed task must add exactly one Obsidian task receipt under
`Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/` and update only the
owner-writable canonical note unless integration review is requested.

Do not weaken these architecture boundaries:

1. Authorization and RBAC are server-side controls.
2. IDEA1, IDEA2, and HUB identities remain decoupled.
3. IDEA3 is fail-secure, and its repository implementation must not be claimed before evidence exists.
4. Tokens never use browser storage; HttpOnly/SameSite cookies and CSRF controls remain enforced.
