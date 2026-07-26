# 🤖 AI Agent Workflow & Vibe Coding Obsidian Sync Rules

> **MANDATORY INSTRUCTION FOR CLAUDE CODE & AI AGENTS**:  
> Upon completing any user prompt, feature request, or "Vibe Coding" task, the AI Agent MUST automatically update the Obsidian Knowledge Base at `C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`.
> The full sync procedure (in-place edit policy, the 3-step update, and the `log.md` template) lives in the `vibe_coding_obsidian_sync` skill — invoke it to perform the sync.

---

## 🛡️ CORE AEGIS ARCHITECTURAL PRINCIPLES (Never Violate)
1. **Server-Side Enforcement**: All auth/RBAC checks occur on backend Express servers.
2. **Identity Decoupling**: IDEA 1, IDEA 2, and HUB are independent identity domains.
3. **Fail-Secure & Air-Gap**: IDEA 3 hardware lockdown cuts WAN Uplink on Heartbeat loss (Dead Man's Switch).
4. **OWASP Hardening**: No `localStorage`/`sessionStorage` for tokens. Use HttpOnly + SameSite=Strict cookies + CSRF tokens.
