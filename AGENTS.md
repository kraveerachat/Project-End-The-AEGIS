# AGENTS.md — Global Rules for AI Coding Assistants in AEGIS System

> **Mandatory instruction for all AI Agents**: Whenever you finish executing a user prompt, writing code, or adding features in this repository, you MUST update the project's Obsidian Knowledge Base in-place.

---

## 📌 Post-Prompt Auto-Sync & In-Place Update Requirement

**Target Obsidian Vault Directory**:  
`C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`

## Shared UI/design workflow

- For frontend design work, read `.agents/skills/impeccable/SKILL.md` before editing and
  infer the command that fits the prompt; the user does not need to name it. Use
  `shape`/`craft` for new surfaces, `layout`/`adapt` for composition, `typeset`/`clarify`
  for text, `colorize`/`audit` for palette and contrast, `critique` for review,
  `harden` for production edge cases, `polish` for final refinement, and `live` for
  browser iteration. Use `animate` only for purposeful state motion with reduced-motion
  fallbacks. The official reference is https://impeccable.style/docs/.
- Follow the Impeccable sequence `shape → craft → critique/audit → polish` for larger
  changes; never apply a command mechanically. Use the existing `PRODUCT.md`/`DESIGN.md`
  register and verify the result against the running surface when possible.
- Read `AEGIS_Knowledge/index.md` and the relevant module note before changing code so
  another agent's architectural and UI decisions are not lost.
- Preserve real API/state/RBAC behavior when a prompt is design-only. Do not add mock
  data, fake telemetry, or unnecessary motion to make a screenshot look complete.
- After UI or deployment work, run the affected tests/build and record meaningful
  deployment or architecture changes in the existing Obsidian notes. Keep local agent
  settings, credentials, and secrets out of commits.

### Procedure upon completing a user prompt:
1. **In-Place Update (แก้ไขในไฟล์เดิม)**:
   - Identify existing notes in `AEGIS_Knowledge` that relate to the code changed.
   - Edit the existing note directly to reflect current code implementation. Replace outdated claims or stale text so notes stay crisp and non-redundant.
   - Do NOT create duplicate files. Create a new note `[NEW]` only if a completely new module/concept is introduced.
2. **Master Overview Update (`00 - 🗺️ AEGIS System Overview.md`)**:
   - Keep the master architecture overview and Mermaid diagrams up to date with the latest code state.
3. **Update Index (`index.md`) & Log (`log.md`)**:
   - If a new note was created, catalog it in `index.md`.
   - Append an entry to `log.md`:
     `## [YYYY-MM-DD] vibe-coding | <Prompt Summary>` listing prompt goal, modified source code paths, and updated Obsidian notes.
