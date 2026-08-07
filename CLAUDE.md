# 🤖 AI Agent Workflow & Vibe Coding Obsidian Sync Rules

> ## 🧭 READ FIRST, EVERY SESSION
> **`Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`**
>
> That file is the single entry point to this project's knowledge base. It carries the system
> orientation, the agent reading protocol, the project knowledge-network diagram, and the full
> table of contents. Read it **before** starting work — then read
> `summaries/08_Outstanding_Items_Consolidated.md` so you don't re-report a known-open bug.

> **MANDATORY INSTRUCTION FOR CLAUDE CODE & AI AGENTS**:  
> Upon completing any user prompt, feature request, or "Vibe Coding" task, the AI Agent MUST automatically update the Obsidian Knowledge Base at `Obsidian_AEGIS_Vault/AEGIS_Knowledge` (path relative to this repository root — do **not** hardcode an absolute path; the repo has moved before).
> The full sync procedure (in-place edit policy, the 3-step update, and the `log.md` template) lives in the `vibe_coding_obsidian_sync` skill — invoke it to perform the sync. The same rules are mirrored in the vault at `06 - 🤖 Agent Operating Rules.md`.

---

## 🛡️ CORE AEGIS ARCHITECTURAL PRINCIPLES (Never Violate)
1. **Server-Side Enforcement**: All auth/RBAC checks occur on backend Express servers.
2. **Identity Decoupling**: IDEA 1, IDEA 2, and HUB are independent identity domains.
3. **Fail-Secure & Air-Gap**: IDEA 3 hardware lockdown cuts WAN Uplink on Heartbeat loss (Dead Man's Switch).
4. **OWASP Hardening**: No `localStorage`/`sessionStorage` for tokens. Use HttpOnly + SameSite=Strict cookies + CSRF tokens.
