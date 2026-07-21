---
name: vibe_coding_obsidian_sync
description: Automatically run after completing any user prompt or coding task to summarize code changes, update existing notes in-place, or create new notes inside Obsidian_AEGIS_Vault/AEGIS_Knowledge.
---

# Vibe Coding Obsidian Sync Skill

Use this skill whenever you complete a user prompt or coding session.

## Action Steps
1. **In-Place Modification**: Update existing Obsidian notes in `AEGIS_Knowledge` directly. Replace obsolete details to prevent duplication.
2. **Master Summary Update**: Ensure `00 - 🗺️ AEGIS System Overview.md` and Mermaid diagrams reflect the latest system architecture.
3. **Log Append**: Append a summary to `log.md` detailing the user prompt goal, touched file paths, and notes updated.
4. **Target Path**: `C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`
