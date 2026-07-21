# AGENTS.md — Global Rules for AI Coding Assistants in AEGIS System

> **Mandatory instruction for all AI Agents**: Whenever you finish executing a user prompt, writing code, or adding features in this repository, you MUST update the project's Obsidian Knowledge Base in-place.

---

## 📌 Post-Prompt Auto-Sync & In-Place Update Requirement

**Target Obsidian Vault Directory**:  
`C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`

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
